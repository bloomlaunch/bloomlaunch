// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FeeMath} from "../FeeMath.sol";
import {FeeEscrow} from "../FeeEscrow.sol";
import {LaunchToken} from "../LaunchToken.sol";
import {BondingCurve} from "../BondingCurve.sol";

interface IHookFactory {
    function launchRouting(address token) external view
        returns (address curve, address quote, address executor, bytes32 poolId);
}
interface IHookExecutor { function feeHook() external view returns (address); }
interface IHookVault {
    function adapter() external view returns (address);
    function deposit(address token, address quote, address beneficiary, uint256 amount) external;
}

/// @notice Canonical post-graduation fee hook for BloomLaunch pools. The pool LP
/// fee is zero; this hook charges exactly the launch's curve economics on the
/// quote leg: 0.20% platform plus the launch's immutable 0-10% creator rate.
/// Fee base is the gross quote amount, as on the curve: exact-input buys and
/// exact-input sells charge on the specified/received gross; exact-output trades
/// charge on the smallest gross whose net covers the pool amount.
/// Only the launch's pinned executor can initialize a pool with this hook.
/// The hook also keeps a time-weighted tick accumulator used by the canonical
/// buyback adapter. It holds no balances between transactions.
contract BloomFeeHook is IHooks {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 public constant TICK_SPACING = 200;
    uint256 public constant OBSERVATION_INTERVAL = 60;
    uint256 public constant OBSERVATION_SLOTS = 64;

    struct Terms {
        address token;
        address quote;
        address curve;
        address escrow;
        address platform;
        address vault;
        bool quoteIs0;
        uint16 creatorBps;
        uint16 holderShareBps;
        uint16 buybackShareBps;
    }
    struct Observation { uint64 timestamp; int192 tickCumulative; }
    struct Oracle {
        int192 tickCumulative;
        uint64 lastUpdate;
        uint16 index;
        uint16 count;
        Observation[64] observations;
    }

    IPoolManager public immutable poolManager;
    IHookFactory public immutable factory;
    mapping(PoolId => Terms) public terms;
    mapping(address token => PoolKey) private keys;
    mapping(PoolId => Oracle) private oracles;

    error NotPoolManager();
    error HookNotImplemented();
    error InvalidPool();
    error OracleUnavailable();
    event CanonicalPoolRegistered(address indexed token, PoolId indexed poolId, address quote);
    event PoolFees(address indexed token, address indexed trader, uint256 platformFee, uint256 creatorFee,
        uint256 holderRewards, uint256 buybackFunding, uint256 creatorEarnings);

    constructor(IPoolManager poolManager_, IHookFactory factory_) {
        poolManager = poolManager_;
        factory = factory_;
        Hooks.validateHookPermissions(this, permissions());
    }

    function permissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true, afterInitialize: false,
            beforeAddLiquidity: false, afterAddLiquidity: false,
            beforeRemoveLiquidity: false, afterRemoveLiquidity: false,
            beforeSwap: true, afterSwap: true,
            beforeDonate: false, afterDonate: false,
            beforeSwapReturnDelta: true, afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false, afterRemoveLiquidityReturnDelta: false
        });
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function poolKey(address token) external view returns (PoolKey memory key) {
        key = keys[token];
        if (address(key.hooks) == address(0)) revert InvalidPool();
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
        external onlyPoolManager returns (bytes4)
    {
        if (key.fee != 0 || key.tickSpacing != TICK_SPACING || address(key.hooks) != address(this)) revert InvalidPool();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        (address curve, address quote, address executor, bytes32 existing) = factory.launchRouting(c0);
        address token = c0;
        if (curve == address(0)) {
            (curve, quote, executor, existing) = factory.launchRouting(c1);
            token = c1;
        }
        if (curve == address(0) || quote != (token == c0 ? c1 : c0) || sender != executor || existing != bytes32(0)
            || IHookExecutor(executor).feeHook() != address(this) || address(keys[token].hooks) != address(0)
            || BondingCurve(curve).phase() != BondingCurve.Phase.PoolActive) revert InvalidPool();
        (, , address escrow, address platform, , address vault, , , , uint16 creatorBps,
            uint16 holderShareBps, uint16 buybackShareBps,) = BondingCurve(curve).settings();
        PoolId id = key.toId();
        terms[id] = Terms(token, quote, curve, escrow, platform, vault, quote == c0,
            creatorBps, holderShareBps, buybackShareBps);
        keys[token] = key;
        IERC20(quote).forceApprove(escrow, type(uint256).max);
        IERC20(quote).forceApprove(token, type(uint256).max);
        IERC20(quote).forceApprove(vault, type(uint256).max);
        Oracle storage o = oracles[id];
        o.lastUpdate = uint64(block.timestamp);
        o.observations[0] = Observation(uint64(block.timestamp), 0);
        o.count = 1;
        sqrtPriceX96; // Price itself is validated by the executor and factory guard.
        emit CanonicalPoolRegistered(token, id, quote);
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        Terms memory t = terms[id];
        if (t.token == address(0)) revert InvalidPool();
        _observe(id);
        bool exactInput = params.amountSpecified < 0;
        bool specifiedIs0 = exactInput == params.zeroForOne;
        if (specifiedIs0 != t.quoteIs0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        // Quote is the specified leg: exact-input buy or exact-output sell.
        uint256 gross = exactInput ? uint256(-params.amountSpecified)
            : FeeMath.grossForNet(uint256(params.amountSpecified), t.creatorBps);
        uint256 fee = _collect(t, sender, gross);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external onlyPoolManager returns (bytes4, int128)
    {
        Terms memory t = terms[key.toId()];
        bool exactInput = params.amountSpecified < 0;
        bool specifiedIs0 = exactInput == params.zeroForOne;
        if (specifiedIs0 == t.quoteIs0) return (IHooks.afterSwap.selector, 0);
        // Quote is the unspecified leg: exact-input sell or exact-output buy.
        int128 quoteDelta = t.quoteIs0 ? delta.amount0() : delta.amount1();
        uint256 gross = exactInput ? uint256(int256(quoteDelta))
            : FeeMath.grossForNet(uint256(-int256(quoteDelta)), t.creatorBps);
        uint256 fee = _collect(t, sender, gross);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function _collect(Terms memory t, address trader, uint256 gross) private returns (uint256 fee) {
        (uint256 platformFee, uint256 creatorFee,) = FeeMath.fees(gross, t.creatorBps);
        fee = platformFee + creatorFee;
        if (fee == 0) return 0;
        poolManager.take(Currency.wrap(t.quote), address(this), fee);
        (uint256 earnings, uint256 holders, uint256 buyback) =
            FeeMath.allocate(creatorFee, t.holderShareBps, t.buybackShareBps);
        BondingCurve curve = BondingCurve(t.curve);
        // Buyback execution must not allocate a further buyback from its own trade.
        if (buyback != 0 && (!curve.buybacksEnabled() || trader == IHookVault(t.vault).adapter())) {
            earnings += buyback;
            buyback = 0;
        }
        address creator = curve.creatorRecipient();
        if (platformFee != 0) FeeEscrow(t.escrow).depositToken(t.quote, t.platform, platformFee);
        if (earnings != 0) FeeEscrow(t.escrow).depositToken(t.quote, creator, earnings);
        if (buyback != 0) IHookVault(t.vault).deposit(t.token, t.quote, creator, buyback);
        if (holders != 0) LaunchToken(t.token).fundRewards(holders);
        emit PoolFees(t.token, trader, platformFee, creatorFee, holders, buyback, earnings);
    }

    function _observe(PoolId id) private {
        Oracle storage o = oracles[id];
        (, int24 tick,,) = poolManager.getSlot0(id);
        uint256 elapsed = block.timestamp - o.lastUpdate;
        if (elapsed == 0) return;
        o.tickCumulative += int192(tick) * int192(int256(elapsed));
        o.lastUpdate = uint64(block.timestamp);
        Observation storage last = o.observations[o.index];
        if (block.timestamp >= last.timestamp + OBSERVATION_INTERVAL) {
            o.index = uint16((o.index + 1) % OBSERVATION_SLOTS);
            o.observations[o.index] = Observation(uint64(block.timestamp), o.tickCumulative);
            if (o.count < OBSERVATION_SLOTS) ++o.count;
        }
    }

    /// @notice Time-weighted mean tick over at least `window` seconds, using the
    /// newest stored observation at or before `now - window`.
    function consult(address token, uint32 window) external view returns (int24 meanTick, int24 spotTick) {
        PoolKey memory key = keys[token];
        if (address(key.hooks) == address(0) || window == 0) revert OracleUnavailable();
        PoolId id = key.toId();
        Oracle storage o = oracles[id];
        (, spotTick,,) = poolManager.getSlot0(id);
        int256 cumulativeNow = int256(o.tickCumulative) + int256(spotTick) * int256(block.timestamp - o.lastUpdate);
        if (block.timestamp < window) revert OracleUnavailable();
        uint256 target = block.timestamp - window;
        for (uint256 i; i < o.count; ++i) {
            Observation memory obs = o.observations[(o.index + OBSERVATION_SLOTS - i) % OBSERVATION_SLOTS];
            if (obs.timestamp <= target) {
                int256 mean = (cumulativeNow - int256(obs.tickCumulative)) / int256(block.timestamp - obs.timestamp);
                return (int24(mean), spotTick);
            }
        }
        revert OracleUnavailable();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta,
        bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta,
        bytes calldata) external pure returns (bytes4, BalanceDelta) { revert HookNotImplemented(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { revert HookNotImplemented(); }
}
