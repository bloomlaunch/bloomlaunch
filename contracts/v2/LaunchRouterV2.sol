// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LaunchFactoryV2 as LaunchFactory, IGraduationExecutor} from "./LaunchFactoryV2.sol";
import {BondingCurveV2 as BondingCurve} from "./BondingCurveV2.sol";
import {FeeEscrow} from "../FeeEscrow.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
interface IRouterHook { function poolKey(address token) external view returns (PoolKey memory); }

/// @notice Stateless launch and trade router across a launch's curve and its
/// canonical V4 pool. Native ETH is wrapped to the configured WETH quote asset
/// and unwrapped on request. Every trade enforces a deadline and a minimum
/// output or maximum input; unused input is refunded to the payer in the same
/// transaction. The router holds no balances between transactions.
/// @notice v2 router. As v1, and launches charge the factory's launch fee (to platform revenue in the
/// fee escrow) and must include a first (dev) buy of at least the factory's minimum, in one transaction.
contract LaunchRouterV2 is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    LaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;
    IWETH public immutable weth;

    error Expired();
    error Slippage();
    error InvalidParameters();
    error Unauthorized();
    error NativeTransferFailed();
    event LaunchFeePaid(address indexed token, address indexed creator, uint256 fee);
    event RoutedTrade(address indexed token, address indexed trader, address indexed recipient, bool buy,
        bool viaPool, uint256 quoteAmount, uint256 tokenAmount);

    constructor(LaunchFactory factory_, IPoolManager poolManager_, IWETH weth_) {
        if (address(factory_) == address(0) || address(poolManager_) == address(0)) revert InvalidParameters();
        factory = factory_;
        poolManager = poolManager_;
        weth = weth_;
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert Unauthorized();
    }

    /// @notice Launches a token attributed to the caller: pays the launch fee and makes the first (dev)
    /// buy of `buyGross` (at least factory.minInitialBuy()). ETH launches only. Pay exactly
    /// launchFee + buyGross in ETH, or approve that much WETH.
    function launch(LaunchFactory.Params calldata p, uint256 configId, address quote,
        uint256 buyGross, uint256 minTokens, uint256 deadline)
        external payable nonReentrant returns (address token, uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (quote != address(weth) || buyGross == 0 || buyGross < factory.minInitialBuy()) revert InvalidParameters();
        uint256 fee = factory.launchFee();
        bool native = _pullQuote(quote, fee + buyGross);
        token = factory.launchFor(msg.sender, p, configId, quote);
        if (fee != 0) {
            FeeEscrow escrow = FeeEscrow(factory.escrow());
            IERC20(quote).forceApprove(address(escrow), fee);
            escrow.depositToken(quote, factory.platformRecipient(), fee);
            emit LaunchFeePaid(token, msg.sender, fee);
        }
        (tokensOut,) = _execute(token, quote, buyGross, minTokens, msg.sender, native);
    }

    /// @notice Exact-input buy on the active venue. Pays with msg.value when the
    /// quote asset is WETH, otherwise with an ERC-20 allowance.
    function buy(address token, uint256 maxGross, uint256 minTokens, address recipient, uint256 deadline)
        external payable nonReentrant returns (uint256 tokensOut, uint256 grossUsed)
    {
        if (block.timestamp > deadline) revert Expired();
        return _buy(token, maxGross, minTokens, recipient);
    }

    /// @notice Exact-input sell on the active venue; `unwrap` returns native ETH for WETH launches.
    function sell(address token, uint256 tokensIn, uint256 minQuote, address recipient, uint256 deadline, bool unwrap)
        external nonReentrant returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        (address curve, address quote,,) = factory.launchRouting(token);
        if (curve == address(0) || tokensIn == 0 || recipient == address(0)) revert InvalidParameters();
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        bool viaPool = BondingCurve(curve).phase() == BondingCurve.Phase.PoolActive;
        if (viaPool) {
            (, quoteOut) = _swap(token, quote, false, -int256(tokensIn));
        } else {
            IERC20(token).forceApprove(curve, tokensIn);
            quoteOut = BondingCurve(curve).sell(tokensIn, minQuote, address(this), deadline);
        }
        if (quoteOut < minQuote || quoteOut == 0) revert Slippage();
        _payOut(quote, quoteOut, recipient, unwrap);
        emit RoutedTrade(token, msg.sender, recipient, false, viaPool, quoteOut, tokensIn);
    }

    /// @notice Exact-output buy on the canonical pool (graduated launches only).
    function buyExactOut(address token, uint256 tokensOut, uint256 maxGross, address recipient, uint256 deadline)
        external payable nonReentrant returns (uint256 grossUsed)
    {
        if (block.timestamp > deadline) revert Expired();
        (address curve, address quote,,) = factory.launchRouting(token);
        if (curve == address(0) || tokensOut == 0 || recipient == address(0)
            || BondingCurve(curve).phase() != BondingCurve.Phase.PoolActive) revert InvalidParameters();
        bool native = _pullQuote(quote, maxGross);
        uint256 received;
        (grossUsed, received) = _swap(token, quote, true, int256(tokensOut));
        if (grossUsed > maxGross || received < tokensOut) revert Slippage();
        IERC20(token).safeTransfer(recipient, received);
        if (maxGross > grossUsed) _payOut(quote, maxGross - grossUsed, msg.sender, native);
        emit RoutedTrade(token, msg.sender, recipient, true, true, grossUsed, received);
    }

    /// @notice Exact-output sell on the canonical pool (graduated launches only).
    function sellExactOut(address token, uint256 quoteOut, uint256 maxTokensIn, address recipient,
        uint256 deadline, bool unwrap) external nonReentrant returns (uint256 tokensIn)
    {
        if (block.timestamp > deadline) revert Expired();
        (address curve, address quote,,) = factory.launchRouting(token);
        if (curve == address(0) || quoteOut == 0 || recipient == address(0)
            || BondingCurve(curve).phase() != BondingCurve.Phase.PoolActive) revert InvalidParameters();
        IERC20(token).safeTransferFrom(msg.sender, address(this), maxTokensIn);
        uint256 received;
        (tokensIn, received) = _swap(token, quote, false, int256(quoteOut));
        if (tokensIn > maxTokensIn || received < quoteOut) revert Slippage();
        _payOut(quote, received, recipient, unwrap);
        if (maxTokensIn > tokensIn) IERC20(token).safeTransfer(msg.sender, maxTokensIn - tokensIn);
        emit RoutedTrade(token, msg.sender, recipient, false, true, received, tokensIn);
    }

    function _buy(address token, uint256 maxGross, uint256 minTokens, address recipient)
        private returns (uint256 tokensOut, uint256 grossUsed)
    {
        (, address quote,,) = factory.launchRouting(token);
        bool native = _pullQuote(quote, maxGross);
        return _execute(token, quote, maxGross, minTokens, recipient, native);
    }

    /// @dev Buys with quote already held by the router (pulled or wrapped by the caller).
    function _execute(address token, address quote, uint256 maxGross, uint256 minTokens, address recipient, bool native)
        private returns (uint256 tokensOut, uint256 grossUsed)
    {
        (address curve,,,) = factory.launchRouting(token);
        if (curve == address(0) || maxGross == 0 || recipient == address(0)) revert InvalidParameters();
        bool viaPool = BondingCurve(curve).phase() == BondingCurve.Phase.PoolActive;
        if (viaPool) {
            (grossUsed, tokensOut) = _swap(token, quote, true, -int256(maxGross));
            if (tokensOut < minTokens || tokensOut == 0) revert Slippage();
            IERC20(token).safeTransfer(recipient, tokensOut);
        } else {
            IERC20(quote).forceApprove(curve, maxGross);
            (tokensOut, grossUsed) = BondingCurve(curve).buy(maxGross, minTokens, recipient, type(uint256).max);
            IERC20(quote).forceApprove(curve, 0);
        }
        // The final curve buy consumes only what completes the curve.
        if (maxGross > grossUsed) _payOut(quote, maxGross - grossUsed, msg.sender, native);
        emit RoutedTrade(token, msg.sender, recipient, true, viaPool, grossUsed, tokensOut);
    }

    function _pullQuote(address quote, uint256 amount) private returns (bool native) {
        if (msg.value != 0) {
            if (quote != address(weth) || msg.value != amount) revert InvalidParameters();
            weth.deposit{value: amount}();
            return true;
        }
        IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
    }

    function _payOut(address quote, uint256 amount, address recipient, bool native) private {
        if (native && quote == address(weth)) {
            weth.withdraw(amount);
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(quote).safeTransfer(recipient, amount);
        }
    }

    /// @return paid Input actually paid by the router; received Output actually received.
    function _swap(address token, address quote, bool buying, int256 amountSpecified)
        private returns (uint256 paid, uint256 received)
    {
        (,, address executor,) = factory.launchRouting(token);
        PoolKey memory key = IRouterHook(IGraduationExecutor(executor).feeHook()).poolKey(token);
        address input = buying ? quote : token;
        bool zeroForOne = Currency.unwrap(key.currency0) == input;
        return abi.decode(poolManager.unlock(abi.encode(key, zeroForOne, amountSpecified)), (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));
        BalanceDelta delta = poolManager.swap(key, SwapParams(zeroForOne, amountSpecified,
            zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
        (Currency input, Currency output) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 paid = uint256(-int256(inDelta));
        uint256 received = uint256(int256(outDelta));
        poolManager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransfer(address(poolManager), paid);
        poolManager.settle();
        if (received != 0) poolManager.take(output, address(this), received);
        return abi.encode(paid, received);
    }
}
