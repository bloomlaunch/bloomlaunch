// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FeeMath} from "../FeeMath.sol";
import {BondingCurve} from "../BondingCurve.sol";

interface IAdapterFactory {
    function launchRouting(address token) external view
        returns (address curve, address quote, address executor, bytes32 poolId);
}
interface IAdapterExecutor { function feeHook() external view returns (address); }
interface IAdapterHook {
    function poolKey(address token) external view returns (PoolKey memory);
    function consult(address token, uint32 window) external view returns (int24 meanTick, int24 spotTick);
}
interface IAdapterVault {
    function adapter() external view returns (address);
    function factory() external view returns (address);
}

/// @notice Canonical-market buyback adapter. Buys only on the launch's canonical
/// BloomLaunch V4 pool, prices limits from the hook's 30-minute time-weighted tick,
/// refuses execution while spot deviates from that mean, caps each trade to a
/// fraction of active quote liquidity, and requires a minimum output. Trades
/// it makes are recognized by the fee hook, which redirects their buyback share
/// to creator earnings so execution never funds another buyback.
contract CanonicalBuybackAdapter is IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint32 public constant TWAP_WINDOW = 30 minutes;
    int24 public constant MAX_SPOT_DEVIATION_TICKS = 100;
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    uint256 public constant MAX_TRADE_BPS_OF_LIQUIDITY = 100;
    uint256 private constant Q96 = 1 << 96;

    IPoolManager public immutable poolManager;
    IAdapterFactory public factory;
    address public immutable bootstrapper;
    address public vault;

    error Unauthorized();
    error InvalidParameters();
    error Slippage();

    constructor(IPoolManager poolManager_, address bootstrapper_) {
        if (address(poolManager_).code.length == 0 || bootstrapper_ == address(0)) revert InvalidParameters();
        poolManager = poolManager_;
        bootstrapper = bootstrapper_;
    }

    /// @notice One-time binding after the vault is bound to its factory. The
    /// factory is taken from the vault, so the two can never disagree.
    function bindVault(address vault_) external {
        if (msg.sender != bootstrapper || vault != address(0)) revert Unauthorized();
        address factory_ = IAdapterVault(vault_).factory();
        if (IAdapterVault(vault_).adapter() != address(this) || factory_ == address(0)) revert InvalidParameters();
        vault = vault_;
        factory = IAdapterFactory(factory_);
    }

    function _pool(address token, address quote) private view returns (PoolKey memory key, IAdapterHook hook, address curve) {
        address launchQuote; address executor; bytes32 poolId;
        (curve, launchQuote, executor, poolId) = factory.launchRouting(token);
        if (curve == address(0) || poolId == bytes32(0) || launchQuote != quote) revert InvalidParameters();
        hook = IAdapterHook(IAdapterExecutor(executor).feeHook());
        key = hook.poolKey(token);
    }

    /// @notice Returns zero limits (which the vault rejects) when no reliable
    /// observation exists or the pool is currently displaced from its mean.
    function limits(address token, address quote, uint256 amount) external view returns (uint256 minTokens, uint256 maxInput) {
        (PoolKey memory key, IAdapterHook hook, address curve) = _pool(token, quote);
        int24 meanTick; int24 spotTick;
        try hook.consult(token, TWAP_WINDOW) returns (int24 mean, int24 spot) { (meanTick, spotTick) = (mean, spot); }
        catch { return (0, 0); }
        int24 deviation = spotTick > meanTick ? spotTick - meanTick : meanTick - spotTick;
        if (deviation > MAX_SPOT_DEVIATION_TICKS) return (0, 0);
        bool quoteIs0 = Currency.unwrap(key.currency0) == quote;
        (, , , , , , , , , uint16 creatorBps, , , ) = BondingCurve(curve).settings();
        (, , uint256 net) = FeeMath.fees(amount, creatorBps);
        uint256 sqrtMean = TickMath.getSqrtPriceAtTick(meanTick);
        uint256 expected = quoteIs0
            ? Math.mulDiv(Math.mulDiv(net, sqrtMean, Q96), sqrtMean, Q96)
            : Math.mulDiv(Math.mulDiv(net, Q96, sqrtMean), Q96, sqrtMean);
        minTokens = Math.mulDiv(expected, 10_000 - MAX_SLIPPAGE_BPS, 10_000);
        PoolId id = key.toId();
        (uint160 sqrtSpot,,,) = poolManager.getSlot0(id);
        uint256 liquidity = poolManager.getLiquidity(id);
        uint256 quoteReserve = quoteIs0 ? Math.mulDiv(liquidity, Q96, sqrtSpot) : Math.mulDiv(liquidity, sqrtSpot, Q96);
        maxInput = Math.mulDiv(quoteReserve, MAX_TRADE_BPS_OF_LIQUIDITY, 10_000);
    }

    function swap(address token, address quote, uint256 amount, uint256 minTokens, address recipient, uint256 deadline) external {
        if (msg.sender != vault || vault == address(0)) revert Unauthorized();
        if (block.timestamp > deadline || amount == 0 || recipient == address(0)) revert InvalidParameters();
        (PoolKey memory key,,) = _pool(token, quote);
        IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
        bool zeroForOne = Currency.unwrap(key.currency0) == quote;
        uint256 received = abi.decode(poolManager.unlock(abi.encode(key, zeroForOne, amount, recipient)), (uint256));
        if (received < minTokens) revert Slippage();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        (PoolKey memory key, bool zeroForOne, uint256 amount, address recipient) =
            abi.decode(data, (PoolKey, bool, uint256, address));
        BalanceDelta delta = poolManager.swap(key, SwapParams(zeroForOne, -int256(amount),
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (uint256(-int256(inDelta)) != amount) revert Slippage();
        (Currency input, Currency output) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        poolManager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransfer(address(poolManager), amount);
        poolManager.settle();
        uint256 received = uint256(int256(outDelta));
        poolManager.take(output, recipient, received);
        return abi.encode(received);
    }
}
