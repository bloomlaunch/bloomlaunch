// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

interface ILockerFactory { function locker() external view returns (address); }
interface ILockerHook {
    function factory() external view returns (address);
    function poolManager() external view returns (address);
    function TICK_SPACING() external view returns (int24);
}

/// @notice Graduation executor and permanent liquidity locker. During graduation it
/// initializes the canonical zero-LP-fee V4 pool at the price implied by the actual
/// released amounts, adds one full-range position owned by this contract inside the
/// PoolManager, and donates any rounding remainder to that locked position.
/// This contract has no code path that removes liquidity or collects fees, and
/// no owner. Any failure reverts the whole graduation transaction.
contract LiquidityLocker is IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = -887200;
    int24 public constant TICK_UPPER = 887200;
    bytes32 public constant POSITION_SALT = bytes32(0);
    uint256 private constant Q96 = 1 << 96;

    struct Lock { address token; address quote; uint128 liquidity; uint64 lockedAt; }

    IPoolManager public immutable poolManager;
    address public immutable bootstrapper;
    address public factory;
    address public feeHook;
    mapping(bytes32 poolId => Lock) public locks;

    error Unauthorized();
    error InvalidParameters();
    error InvalidPrice();
    event Bound(address indexed factory, address indexed feeHook);
    event LiquidityLocked(address indexed token, bytes32 indexed poolId, uint128 liquidity,
        uint160 sqrtPriceX96, uint256 tokenAmount, uint256 quoteAmount);

    constructor(IPoolManager poolManager_, address bootstrapper_) {
        if (address(poolManager_).code.length == 0 || bootstrapper_ == address(0)) revert InvalidParameters();
        poolManager = poolManager_;
        bootstrapper = bootstrapper_;
    }

    /// @notice Resolves deployment ordering once. It cannot be repeated or undone.
    function bind(address factory_, address feeHook_) external {
        if (msg.sender != bootstrapper || factory != address(0)) revert Unauthorized();
        if (ILockerFactory(factory_).locker() != address(this) || ILockerHook(feeHook_).factory() != factory_
            || ILockerHook(feeHook_).poolManager() != address(poolManager)
            || ILockerHook(feeHook_).TICK_SPACING() != TICK_SPACING) revert InvalidParameters();
        factory = factory_;
        feeHook = feeHook_;
        emit Bound(factory_, feeHook_);
    }

    function execute(address token, address quote, uint256 tokens, uint256 quoteAmount)
        external returns (bytes32 poolId)
    {
        if (msg.sender != factory || factory == address(0)) revert Unauthorized();
        if (token == quote || tokens == 0 || quoteAmount == 0 || tokens > type(uint128).max
            || quoteAmount > type(uint128).max || IERC20(token).balanceOf(address(this)) < tokens
            || IERC20(quote).balanceOf(address(this)) < quoteAmount) revert InvalidParameters();
        bool tokenIs0 = token < quote;
        (uint256 amount0, uint256 amount1) = tokenIs0 ? (tokens, quoteAmount) : (quoteAmount, tokens);
        PoolKey memory key = PoolKey(Currency.wrap(tokenIs0 ? token : quote), Currency.wrap(tokenIs0 ? quote : token),
            0, TICK_SPACING, IHooks(feeHook));
        uint160 sqrtPriceX96 = sqrtPriceFor(amount0, amount1);
        poolManager.initialize(key, sqrtPriceX96);
        uint128 liquidity = abi.decode(poolManager.unlock(abi.encode(key, amount0, amount1, sqrtPriceX96)), (uint128));
        poolId = PoolId.unwrap(key.toId());
        locks[poolId] = Lock(token, quote, liquidity, uint64(block.timestamp));
        emit LiquidityLocked(token, poolId, liquidity, sqrtPriceX96, tokens, quoteAmount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        (PoolKey memory key, uint256 amount0, uint256 amount1, uint160 sqrtPriceX96) =
            abi.decode(data, (PoolKey, uint256, uint256, uint160));
        uint128 liquidity = liquidityFor(sqrtPriceX96, amount0, amount1);
        if (liquidity == 0) revert InvalidParameters();
        (BalanceDelta delta,) = poolManager.modifyLiquidity(key,
            ModifyLiquidityParams(TICK_LOWER, TICK_UPPER, int256(uint256(liquidity)), POSITION_SALT), "");
        uint256 owed0 = uint256(-int256(delta.amount0()));
        uint256 owed1 = uint256(-int256(delta.amount1()));
        if (owed0 > amount0 || owed1 > amount1) revert InvalidParameters();
        // Rounding remainders become fees of the locked position: never withdrawable.
        if (amount0 > owed0 || amount1 > owed1) poolManager.donate(key, amount0 - owed0, amount1 - owed1, "");
        _settle(key.currency0, amount0);
        _settle(key.currency1, amount1);
        return abi.encode(liquidity);
    }

    function _settle(Currency currency, uint256 amount) private {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
    }

    /// @notice True only while the PoolManager records at least the locked liquidity
    /// for this contract's full-range position. No function can reduce it.
    function isLocked(bytes32 poolId) external view returns (bool) {
        Lock memory l = locks[poolId];
        if (l.liquidity == 0) return false;
        bytes32 positionId = Position.calculatePositionKey(address(this), TICK_LOWER, TICK_UPPER, POSITION_SALT);
        return poolManager.getPositionLiquidity(PoolId.wrap(poolId), positionId) >= l.liquidity;
    }

    function sqrtPriceFor(uint256 amount0, uint256 amount1) public pure returns (uint160 sqrtPriceX96) {
        if (amount0 == 0 || amount1 == 0 || amount1 / amount0 >= (1 << 64)) revert InvalidPrice();
        uint256 root = Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0));
        if (root <= TickMath.getSqrtPriceAtTick(TICK_LOWER) || root >= TickMath.getSqrtPriceAtTick(TICK_UPPER)) revert InvalidPrice();
        sqrtPriceX96 = uint160(root);
    }

    function liquidityFor(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1) public pure returns (uint128) {
        uint256 lower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint256 upper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 l0 = Math.mulDiv(amount0, Math.mulDiv(sqrtPriceX96, upper, Q96), upper - sqrtPriceX96);
        uint256 l1 = Math.mulDiv(amount1, Q96, sqrtPriceX96 - lower);
        uint256 liquidity = l0 < l1 ? l0 : l1;
        if (liquidity > type(uint128).max) revert InvalidParameters();
        return uint128(liquidity);
    }
}
