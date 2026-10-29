// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FeeMath} from "../FeeMath.sol";
import {FeeEscrow} from "../FeeEscrow.sol";
import {LaunchToken} from "../LaunchToken.sol";

interface IGraduationCallback {
    function tryGraduate(address token) external returns (bytes32);
}
interface IBuybackFunding {
    function deposit(address token, address quote, address beneficiary, uint256 amount) external;
}

/// @notice BloomLaunch v2 bonding curve. Same economics and safety as v1, and it also presents
/// itself as a Uniswap V3-style pool between the token and its quote asset: the standard V3 pool
/// views (token0, token1, factory, fee, tickSpacing, slot0, liquidity) and the standard V3 Initialize
/// and Swap events, all derived from the curve's live virtual reserves. Market-data indexers that
/// track V3 pools therefore list every launch from its first trade. The curve is a constant-product
/// market on virtual reserves, which is exactly a full-range V3 position, so the values are exact.
contract BondingCurveV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Phase { Uninitialized, CurveActive, GraduationPending, PoolActive, Refunded }
    struct Settings {
        address factory;
        address quote;
        address escrow;
        address platform;
        address creator;
        address buyback;
        uint256 supply;
        uint256 reservedTokens;
        uint256 phantomQuote;
        uint16 creatorBps;
        uint16 holderShareBps;
        uint16 buybackShareBps;
        bool protection;
    }
    Settings public settings;
    address public immutable initializer;
    uint256 public immutable phantomTokens;
    LaunchToken public token;
    Phase public phase;
    uint256 public tokenReserve;
    uint256 public realQuoteReserve;
    uint256 public pendingSince;
    uint256 public refundSupply;
    /// @notice Real quote released at graduation (prices the finished curve in slot0()).
    uint256 public finalQuote;
    bool public buybacksEnabled;
    uint256 public constant RECOVERY_DELAY = 7 days;
    /// @notice Gas forwarded to the automatic graduation attempt. The completing buy
    /// reverts unless this much remains, so a gas estimate can never settle on a
    /// limit at which graduation silently runs out of gas inside the try/catch.
    uint256 public constant GRADUATION_GAS = 3_000_000;
    /// @notice Optional opening snipe protection, chosen by the creator at launch:
    /// for PROTECTION_WINDOW after launch each recipient wallet may buy at most
    /// PROTECTION_MAX_WALLET_BPS of supply. No extra fee or tax is charged, and the
    /// creator payout wallet is exempt. It limits, but cannot eliminate, sniping
    /// by actors who split purchases across many wallets.
    uint256 public constant PROTECTION_WINDOW = 5 minutes;
    uint256 public constant PROTECTION_MAX_WALLET_BPS = 100;
    uint256 public launchedAt;
    bool public protectionEnded;
    mapping(address => uint256) public protectedBought;
    /// @notice Wallets the creator exempted from opening protection at launch (at most 32), disclosed onchain.
    uint256 public constant MAX_PROTECTION_EXEMPT = 32;
    mapping(address => bool) public protectionExempt;
    uint256 public protectionExemptCount;
    error InvalidState();
    error InvalidParameters();
    error Unauthorized();
    error Slippage();
    error Expired();
    error UnsupportedAsset();
    error InsufficientGraduationGas();
    error ProtectionLimit();
    event Trade(address indexed trader, address indexed recipient, bool buy, uint256 tokens,
        uint256 grossQuote, uint256 platformFee, uint256 creatorFee);
    event PhaseChanged(Phase phase);
    event Refunded(address indexed holder, address indexed recipient, uint256 tokens, uint256 quote);
    event GraduationAttemptFailed(bytes reason);
    event BuybacksEnabled(bool enabled);
    event ProtectionEnded();
    event ProtectionExempted(address indexed account);
    /// @notice Uniswap V3 pool events (same signatures, so V3 indexers decode them).
    event Initialize(uint160 sqrtPriceX96, int24 tick);
    event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1,
        uint160 sqrtPriceX96, uint128 liquidity, int24 tick);

    constructor(Settings memory s) {
        if (s.factory == address(0) || s.quote == address(0) || s.escrow == address(0)
            || s.platform == address(0) || s.creator == address(0) || s.buyback == address(0)
            || s.supply == 0 || s.supply > type(uint128).max || s.reservedTokens == 0
            || s.reservedTokens >= s.supply / 2 || s.phantomQuote == 0 || s.phantomQuote > type(uint128).max)
            revert InvalidParameters();
        FeeMath.fees(0, s.creatorBps);
        FeeMath.allocate(0, s.holderShareBps, s.buybackShareBps);
        settings = s;
        buybacksEnabled = s.buybackShareBps != 0;
        // Calibrates virtual-token inventory so terminal curve and pool spot
        // prices agree, subject only to integer rounding of token base units.
        phantomTokens = Math.mulDiv(s.reservedTokens, s.reservedTokens, s.supply - 2 * s.reservedTokens);
        if (phantomTokens == 0) revert InvalidParameters();
        initializer = msg.sender;
    }

    function initialize(LaunchToken token_, address[] calldata exempt) external {
        if (msg.sender != initializer) revert Unauthorized();
        if (exempt.length > MAX_PROTECTION_EXEMPT || (exempt.length != 0 && !settings.protection)) revert InvalidParameters();
        for (uint256 i; i < exempt.length; ++i) {
            if (exempt[i] == address(0) || protectionExempt[exempt[i]]) revert InvalidParameters();
            protectionExempt[exempt[i]] = true;
            emit ProtectionExempted(exempt[i]);
        }
        protectionExemptCount = exempt.length;
        if (phase != Phase.Uninitialized || token_.balanceOf(address(this)) != settings.supply
            || address(token_.rewardAsset()) != settings.quote) revert InvalidState();
        token = token_;
        tokenReserve = settings.supply + phantomTokens;
        launchedAt = block.timestamp;
        phase = Phase.CurveActive;
        IERC20(settings.quote).forceApprove(settings.escrow, type(uint256).max);
        IERC20(settings.quote).forceApprove(address(token_), type(uint256).max);
        IERC20(settings.quote).forceApprove(settings.buyback, type(uint256).max);
        emit PhaseChanged(phase);
        (uint160 sqrtPriceX96, int24 tick) = _price();
        emit Initialize(sqrtPriceX96, tick);
    }

    function protectionActive() public view returns (bool) {
        return settings.protection && !protectionEnded && block.timestamp < launchedAt + PROTECTION_WINDOW;
    }

    /// @notice Tokens `account` may still buy while protection is active (max uint when unrestricted).
    function protectionAllowance(address account) public view returns (uint256) {
        if (!protectionActive() || account == settings.creator || protectionExempt[account]) return type(uint256).max;
        uint256 cap = settings.supply * PROTECTION_MAX_WALLET_BPS / 10_000;
        return cap > protectedBought[account] ? cap - protectedBought[account] : 0;
    }

    function endProtection() external {
        if (msg.sender != settings.factory) revert Unauthorized();
        if (!settings.protection || protectionEnded) revert InvalidState();
        protectionEnded = true;
        emit ProtectionEnded();
    }

    function quoteReserve() public view returns (uint256) { return settings.phantomQuote + realQuoteReserve; }
    function creatorRecipient() external view returns (address) { return settings.creator; }
    function remaining() public view returns (uint256) {
        return phase == Phase.CurveActive ? tokenReserve - phantomTokens - settings.reservedTokens : 0;
    }

    function quoteBuy(uint256 maxGross) public view returns
        (uint256 tokensOut, uint256 grossUsed, uint256 platformFee, uint256 creatorFee, uint256 net)
    {
        if (phase != Phase.CurveActive) revert InvalidState();
        (platformFee, creatorFee, net) = FeeMath.fees(maxGross, settings.creatorBps);
        uint256 sellable = remaining();
        uint256 finalNet = Math.mulDiv(quoteReserve(), sellable, settings.reservedTokens + phantomTokens, Math.Rounding.Ceil);
        grossUsed = maxGross;
        if (net >= finalNet) {
            grossUsed = FeeMath.grossForNet(finalNet, settings.creatorBps);
            (platformFee, creatorFee, net) = FeeMath.fees(grossUsed, settings.creatorBps);
            tokensOut = sellable;
        } else {
            tokensOut = Math.mulDiv(tokenReserve, net, quoteReserve() + net);
        }
    }

    function quoteSell(uint256 tokensIn) public view returns
        (uint256 net, uint256 gross, uint256 platformFee, uint256 creatorFee)
    {
        if (phase != Phase.CurveActive) revert InvalidState();
        if (tokensIn > settings.supply + phantomTokens - tokenReserve) revert InvalidParameters();
        gross = Math.mulDiv(quoteReserve(), tokensIn, tokenReserve + tokensIn);
        (platformFee, creatorFee, net) = FeeMath.fees(gross, settings.creatorBps);
        if (gross > realQuoteReserve) revert InvalidParameters();
    }

    function buy(uint256 maxGross, uint256 minTokens, address recipient, uint256 deadline)
        external nonReentrant returns (uint256 tokensOut, uint256 grossUsed)
    {
        _validate(recipient, deadline, true);
        uint256 platformFee; uint256 creatorFee; uint256 net;
        (tokensOut, grossUsed, platformFee, creatorFee, net) = quoteBuy(maxGross);
        if (tokensOut == 0 || tokensOut < minTokens) revert Slippage();
        if (protectionActive() && recipient != settings.creator && !protectionExempt[recipient]) {
            if (tokensOut > protectionAllowance(recipient)) revert ProtectionLimit();
            protectedBought[recipient] += tokensOut;
        }
        _pull(IERC20(settings.quote), msg.sender, grossUsed);
        realQuoteReserve += net;
        tokenReserve -= tokensOut;
        if (tokenReserve == settings.reservedTokens + phantomTokens) {
            phase = Phase.GraduationPending;
            pendingSince = block.timestamp;
            emit PhaseChanged(phase);
        }
        IERC20(address(token)).safeTransfer(recipient, tokensOut);
        _fees(platformFee, creatorFee);
        emit Trade(msg.sender, recipient, true, tokensOut, grossUsed, platformFee, creatorFee);
        _emitSwap(recipient, int256(grossUsed), -int256(tokensOut));
        if (phase == Phase.GraduationPending) {
            if (gasleft() < GRADUATION_GAS + GRADUATION_GAS / 63 + 10_000) revert InsufficientGraduationGas();
            try IGraduationCallback(settings.factory).tryGraduate{gas: GRADUATION_GAS}(address(token)) returns (bytes32) {}
            catch (bytes memory reason) { emit GraduationAttemptFailed(reason); }
        }
    }

    function sell(uint256 tokensIn, uint256 minQuote, address recipient, uint256 deadline)
        external nonReentrant returns (uint256 net)
    {
        _validate(recipient, deadline, false);
        uint256 gross; uint256 platformFee; uint256 creatorFee;
        (net, gross, platformFee, creatorFee) = quoteSell(tokensIn);
        if (tokensIn == 0 || net == 0 || net < minQuote) revert Slippage();
        _pull(IERC20(address(token)), msg.sender, tokensIn);
        tokenReserve += tokensIn;
        realQuoteReserve -= gross;
        _fees(platformFee, creatorFee);
        IERC20(settings.quote).safeTransfer(recipient, net);
        emit Trade(msg.sender, recipient, false, tokensIn, gross, platformFee, creatorFee);
        _emitSwap(recipient, -int256(net), int256(tokensIn));
    }

    /// @dev Tokens are never bought into reward-excluded contracts. Sells pay out the quote
    /// asset, so excluded contracts such as the router may receive sell proceeds.
    function _validate(address recipient, uint256 deadline, bool receivesTokens) private view {
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0) || recipient == address(this) || (receivesTokens && token.excluded(recipient))) revert InvalidParameters();
    }

    function _pull(IERC20 asset, address sender, uint256 amount) private {
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(sender, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedAsset();
    }

    function _fees(uint256 platformFee, uint256 creatorFee) private {
        FeeEscrow escrow = FeeEscrow(settings.escrow);
        (uint256 earnings, uint256 holders, uint256 buyback) = FeeMath.allocate(
            creatorFee, settings.holderShareBps, settings.buybackShareBps);
        if (!buybacksEnabled) { earnings += buyback; buyback = 0; }
        if (platformFee != 0) escrow.depositToken(settings.quote, settings.platform, platformFee);
        if (earnings != 0) escrow.depositToken(settings.quote, settings.creator, earnings);
        if (buyback != 0) IBuybackFunding(settings.buyback).deposit(address(token), settings.quote, settings.creator, buyback);
        if (holders != 0) token.fundRewards(holders);
    }

    // ---- Uniswap V3-style pool views ----
    /// @notice Lower-addressed asset of the pair, as in Uniswap.
    function token0() public view returns (address) { return _quoteIs0() ? settings.quote : address(token); }
    function token1() public view returns (address) { return _quoteIs0() ? address(token) : settings.quote; }
    function factory() external view returns (address) { return settings.factory; }
    /// @notice Total trading fee in hundredths of a basis point (0.20% platform + creator fee).
    function fee() external view returns (uint24) { return uint24((FeeMath.PLATFORM_BPS + settings.creatorBps) * 100); }
    function tickSpacing() external pure returns (int24) { return 1; }
    /// @notice Virtual constant-product liquidity while trading on the curve; zero once it is no longer
    /// trading here, so indexers follow the graduated Uniswap V4 pool.
    function liquidity() public view returns (uint128) {
        return phase == Phase.CurveActive ? uint128(Math.sqrt(quoteReserve() * tokenReserve)) : 0;
    }
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex,
        uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)
    {
        (sqrtPriceX96, tick) = _price();
        return (sqrtPriceX96, tick, 0, 0, 0, 0, true);
    }

    function _quoteIs0() private view returns (bool) { return settings.quote < address(token); }

    /// @dev Spot price token1/token0 in base units from the virtual reserves, as a Q64.96 square root.
    /// After graduation the reserves are released, so the last curve price is reported.
    function _price() private view returns (uint160 sqrtPriceX96, int24 tick) {
        uint256 q = quoteReserve();
        uint256 t = tokenReserve;
        if (t == 0) { q = settings.phantomQuote + finalQuote; t = settings.reservedTokens + phantomTokens; }
        (uint256 r0, uint256 r1) = _quoteIs0() ? (q, t) : (t, q);
        uint256 root = Math.sqrt(Math.mulDiv(r1, 1 << 192, r0));
        if (root < TickMath.MIN_SQRT_PRICE) root = TickMath.MIN_SQRT_PRICE;
        if (root >= TickMath.MAX_SQRT_PRICE) root = TickMath.MAX_SQRT_PRICE - 1;
        sqrtPriceX96 = uint160(root);
        tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
    }

    /// @dev Pool-perspective amounts: positive flows into the curve, negative flows out.
    function _emitSwap(address recipient, int256 quoteDelta, int256 tokenDelta) private {
        (uint160 sqrtPriceX96, int24 tick) = _price();
        (int256 amount0, int256 amount1) = _quoteIs0() ? (quoteDelta, tokenDelta) : (tokenDelta, quoteDelta);
        // Price and liquidity after the trade (a completing buy reports the final curve state).
        emit Swap(msg.sender, recipient, amount0, amount1, sqrtPriceX96, uint128(Math.sqrt(quoteReserve() * tokenReserve)), tick);
    }

    /// @dev Only factory may call, inside the same transaction as pool creation.
    /// Factory must revert the whole subcall if executor fails or returns no pool.
    function releaseForGraduation(address executor) external returns (uint256 tokens, uint256 quote) {
        if (msg.sender != settings.factory) revert Unauthorized();
        if (phase != Phase.GraduationPending || executor == address(0)) revert InvalidState();
        phase = Phase.PoolActive;
        tokens = tokenReserve - phantomTokens;
        quote = realQuoteReserve;
        finalQuote = quote;
        tokenReserve = 0;
        realQuoteReserve = 0;
        IERC20(address(token)).safeTransfer(executor, tokens);
        IERC20(settings.quote).safeTransfer(executor, quote);
        emit PhaseChanged(phase);
    }

    function changeCreator(address recipient) external {
        if (msg.sender != settings.factory) revert Unauthorized();
        if (recipient == address(0)) revert InvalidParameters();
        settings.creator = recipient;
    }

    function setBuybacksEnabled(bool enabled) external {
        if (msg.sender != settings.factory) revert Unauthorized();
        if (enabled && settings.buybackShareBps == 0) revert InvalidParameters();
        buybacksEnabled = enabled;
        emit BuybacksEnabled(enabled);
    }

    function startRecovery() external {
        if (phase != Phase.GraduationPending || block.timestamp < pendingSince + RECOVERY_DELAY) revert InvalidState();
        phase = Phase.Refunded;
        refundSupply = settings.supply + phantomTokens - tokenReserve;
        emit PhaseChanged(phase);
    }

    function refund(uint256 tokensIn, address recipient) external nonReentrant returns (uint256 quoteOut) {
        if (phase != Phase.Refunded || tokensIn == 0 || tokensIn > refundSupply
            || recipient == address(0) || recipient == address(this)) revert InvalidState();
        quoteOut = Math.mulDiv(realQuoteReserve, tokensIn, refundSupply);
        _pull(IERC20(address(token)), msg.sender, tokensIn);
        refundSupply -= tokensIn;
        tokenReserve += tokensIn;
        realQuoteReserve -= quoteOut;
        IERC20(settings.quote).safeTransfer(recipient, quoteOut);
        emit Refunded(msg.sender, recipient, tokensIn, quoteOut);
    }
}
