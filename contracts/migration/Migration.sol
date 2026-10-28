// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LaunchFactory} from "../LaunchFactory.sol";
import {LaunchToken} from "../LaunchToken.sol";
import {BondingCurve} from "../BondingCurve.sol";

/// @notice Moves a community from an external token onto a BloomLaunch replacement.
///
/// 1. Deposits: holders deposit the old token into fixed epochs. Each epoch has a
///    fixed credit rate and cap; a full epoch closes early and deposits flow to the
///    next one. Deposits can be withdrawn until the deposit period ends.
/// 2. Selling: if the minimum participation was reached, anyone (normally the
///    keeper) sells deposited old tokens into the old token's Uniswap V4 market in
///    bounded tranches: a cooldown, a maximum tranche size, a maximum price impact
///    per tranche (enforced as a swap price limit) and an absolute price floor.
/// 3. Settlement: the recovered quote buys the replacement, a normal BloomLaunch
///    token, on its bonding curve (graduating it if large enough). Replacement
///    tokens are claimable pro rata to credits, vesting linearly, for 90 days;
///    afterwards unclaimed tokens are burned. Holder rewards the contract earns on
///    unclaimed tokens are shared pro rata to credits.
/// 4. Failure (too few deposits, too little proceeds, or no settlement in time):
///    depositors reclaim their share of unsold old tokens and of the proceeds.
///    Each asset is a separate withdrawal, so a reverting old-token transfer can
///    never block the quote refund.
///
/// No administrator can withdraw deposits or change terms. Old-market sales pay
/// that market's fees; the replacement purchase pays normal BloomLaunch fees.
contract Migration is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    enum Phase { Deposits, Selling, Settled, Failed }
    struct Epoch { uint64 end; uint128 rate; uint128 cap; }
    struct SaleRules {
        uint256 minDeposits;
        uint256 minProceeds;
        uint256 floorPriceX18;
        uint16 maxImpactBps;
        uint16 maxTrancheBps;
        uint32 cooldown;
        uint64 saleDeadline;
        uint64 settleDeadline;
        uint32 vestingDuration;
    }
    struct Replacement {
        string name;
        string symbol;
        string metadataURI;
        address creatorRecipient;
        uint16 creatorBps;
        uint16 holderShareBps;
        uint16 buybackShareBps;
        uint256 configId;
    }

    uint256 public constant CLAIM_WINDOW = 90 days;
    uint256 public constant RATE_SCALE = 1e18;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    LaunchFactory public immutable launchFactory;
    IPoolManager public immutable poolManager;
    IERC20 public immutable oldToken;
    IERC20 public immutable quote;
    PoolKey internal oldPool;
    Epoch[] internal epochList;
    Replacement internal replacement;
    SaleRules public rules;

    Phase public phase;
    uint256 public totalDeposited;
    uint256 public totalCredits;
    uint256 public sold;
    uint256 public proceeds;
    uint256 public lastSale;
    mapping(uint256 epoch => uint256) public epochDeposited;
    mapping(address => mapping(uint256 epoch => uint256)) public deposits;
    mapping(address => uint256) public depositedOf;
    mapping(address => uint256) public creditsOf;

    address public replacementToken;
    uint256 public replacementTotal;
    uint256 public leftoverQuote;
    uint64 public settledAt;
    bool public claimsClosed;
    uint256 public rewardPot;
    mapping(address => uint256) public claimed;
    mapping(address => uint256) public rewardsPaid;
    mapping(address => bool) public oldLegWithdrawn;
    mapping(address => bool) public quoteLegWithdrawn;

    error InvalidTerms();
    error InvalidState();
    error InvalidAmount();
    error EpochFull();
    error Cooldown();
    error PriceFloor();
    error Slippage();
    error Unauthorized();
    event Deposited(address indexed account, uint256 indexed epoch, uint256 amount, uint256 credits);
    event Withdrawn(address indexed account, uint256 indexed epoch, uint256 amount, uint256 credits);
    event PhaseChanged(Phase phase);
    event TrancheSold(address indexed caller, uint256 oldIn, uint256 quoteOut);
    event SettledReplacement(address indexed token, uint256 quoteSpent, uint256 tokens, uint256 leftoverQuote);
    event Claimed(address indexed account, uint256 tokens);
    event RewardsClaimed(address indexed account, uint256 amount);
    event LegWithdrawn(address indexed account, address indexed asset, uint256 amount);
    event ClaimsClosed(uint256 burned);

    constructor(LaunchFactory launchFactory_, IPoolManager poolManager_, address oldToken_, address quote_,
        PoolKey memory oldPool_, Epoch[] memory epochs_, SaleRules memory rules_, Replacement memory replacement_)
    {
        if (oldToken_ == quote_ || oldToken_.code.length == 0 || epochs_.length == 0 || epochs_.length > 8) revert InvalidTerms();
        address c0 = Currency.unwrap(oldPool_.currency0);
        address c1 = Currency.unwrap(oldPool_.currency1);
        if (!((c0 == oldToken_ && c1 == quote_) || (c0 == quote_ && c1 == oldToken_))) revert InvalidTerms();
        uint64 previous = uint64(block.timestamp);
        for (uint256 i; i < epochs_.length; ++i) {
            if (epochs_[i].end <= previous || epochs_[i].rate == 0 || epochs_[i].cap == 0) revert InvalidTerms();
            previous = epochs_[i].end;
            epochList.push(epochs_[i]);
        }
        if (rules_.saleDeadline <= previous || rules_.settleDeadline < rules_.saleDeadline || rules_.minDeposits == 0
            || rules_.maxImpactBps == 0 || rules_.maxImpactBps > 2_000 || rules_.maxTrancheBps == 0
            || rules_.maxTrancheBps > 10_000 || rules_.vestingDuration > 30 days) revert InvalidTerms();
        (,,, address configQuote,, bool enabled) = launchFactory_.configs(replacement_.configId);
        if (configQuote != quote_ || !enabled || replacement_.creatorRecipient == address(0)) revert InvalidTerms();
        launchFactory = launchFactory_;
        poolManager = poolManager_;
        oldToken = IERC20(oldToken_);
        quote = IERC20(quote_);
        oldPool = oldPool_;
        rules = rules_;
        replacement = replacement_;
    }

    // ---------------- views ----------------
    function epochCount() external view returns (uint256) { return epochList.length; }
    function epoch(uint256 index) external view returns (Epoch memory) { return epochList[index]; }
    function oldPoolKey() external view returns (PoolKey memory) { return oldPool; }
    function replacementTerms() external view returns (Replacement memory) { return replacement; }
    function depositsEnd() public view returns (uint64) { return epochList[epochList.length - 1].end; }

    /// @return index The epoch new deposits go to; @return open False once deposits are closed or full.
    function currentEpoch() public view returns (uint256 index, bool open) {
        for (uint256 i; i < epochList.length; ++i) {
            if (block.timestamp < epochList[i].end && epochDeposited[i] < epochList[i].cap) return (i, true);
        }
        return (0, false);
    }

    function canSettle() public view returns (bool) {
        return phase == Phase.Selling && (sold == totalDeposited || block.timestamp > rules.saleDeadline)
            && block.timestamp <= rules.settleDeadline && proceeds >= rules.minProceeds && proceeds != 0;
    }

    /// @notice Parameters this migration passes to the launch factory; clients search
    /// `tokenSalt` against them so the replacement address carries the BloomLaunch suffix.
    function launchParams(bytes32 tokenSalt) public view returns (LaunchFactory.Params memory p) {
        Replacement memory r = replacement;
        p = LaunchFactory.Params(r.name, r.symbol, r.metadataURI, r.creatorRecipient, r.creatorBps, r.holderShareBps,
            r.buybackShareBps, keccak256(abi.encode(address(this))),
            launchFactory.previewEconomics(r.configId, address(quote)), tokenSalt, false, new address[](0));
    }

    function maxTranche() public view returns (uint256) {
        uint256 cap = Math.mulDiv(totalDeposited, rules.maxTrancheBps, 10_000);
        uint256 unsold = totalDeposited - sold;
        return cap < unsold ? cap : unsold;
    }

    // ---------------- deposits ----------------
    function deposit(uint256 amount) external nonReentrant returns (uint256 credits) {
        if (phase != Phase.Deposits) revert InvalidState();
        (uint256 index, bool open) = currentEpoch();
        if (!open || amount == 0) revert InvalidAmount();
        uint256 before = oldToken.balanceOf(address(this));
        oldToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = oldToken.balanceOf(address(this)) - before;
        if (received == 0) revert InvalidAmount();
        if (epochDeposited[index] + received > epochList[index].cap) revert EpochFull();
        credits = Math.mulDiv(received, epochList[index].rate, RATE_SCALE);
        epochDeposited[index] += received;
        deposits[msg.sender][index] += received;
        depositedOf[msg.sender] += received;
        creditsOf[msg.sender] += credits;
        totalDeposited += received;
        totalCredits += credits;
        emit Deposited(msg.sender, index, received, credits);
    }

    function withdraw(uint256 index, uint256 amount) external nonReentrant {
        if (phase != Phase.Deposits || block.timestamp >= depositsEnd()) revert InvalidState();
        if (amount == 0 || amount > deposits[msg.sender][index]) revert InvalidAmount();
        uint256 credits = Math.mulDiv(amount, epochList[index].rate, RATE_SCALE);
        if (credits > creditsOf[msg.sender]) credits = creditsOf[msg.sender];
        deposits[msg.sender][index] -= amount;
        epochDeposited[index] -= amount;
        depositedOf[msg.sender] -= amount;
        creditsOf[msg.sender] -= credits;
        totalDeposited -= amount;
        totalCredits -= credits;
        oldToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, index, amount, credits);
    }

    /// @notice Anyone may close deposits once the last epoch ended or every epoch is full.
    function closeDeposits() external {
        (, bool open) = currentEpoch();
        if (phase != Phase.Deposits || open) revert InvalidState();
        phase = totalDeposited >= rules.minDeposits ? Phase.Selling : Phase.Failed;
        emit PhaseChanged(phase);
    }

    // ---------------- selling ----------------
    /// @notice Sells up to `amount` old tokens; fills partially if the impact limit is reached.
    function sellTranche(uint256 amount, uint256 minQuoteOut) external nonReentrant returns (uint256 oldIn, uint256 quoteOut) {
        if (phase != Phase.Selling || block.timestamp > rules.saleDeadline) revert InvalidState();
        if (lastSale != 0 && block.timestamp < lastSale + rules.cooldown) revert Cooldown();
        if (amount == 0 || amount > maxTranche()) revert InvalidAmount();
        (oldIn, quoteOut) = abi.decode(poolManager.unlock(abi.encode(amount)), (uint256, uint256));
        if (oldIn == 0 || quoteOut < minQuoteOut) revert Slippage();
        if (Math.mulDiv(quoteOut, RATE_SCALE, oldIn) < rules.floorPriceX18) revert PriceFloor();
        sold += oldIn;
        proceeds += quoteOut;
        lastSale = block.timestamp;
        emit TrancheSold(msg.sender, oldIn, quoteOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        uint256 amount = abi.decode(data, (uint256));
        PoolKey memory key = oldPool;
        bool zeroForOne = Currency.unwrap(key.currency0) == address(oldToken);
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(key.toId());
        uint256 factor = Math.sqrt(Math.mulDiv(10_000 - rules.maxImpactBps, 1e36, 10_000));
        uint256 limit = zeroForOne ? Math.mulDiv(sqrtPrice, factor, 1e18) : Math.mulDiv(sqrtPrice, 1e18, factor);
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        if (limit >= TickMath.MAX_SQRT_PRICE) limit = TickMath.MAX_SQRT_PRICE - 1;
        BalanceDelta delta = poolManager.swap(key, SwapParams(zeroForOne, -int256(amount), uint160(limit)), "");
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 paid = uint256(-int256(inDelta));
        uint256 received = outDelta > 0 ? uint256(int256(outDelta)) : 0;
        if (paid > amount) revert Slippage();
        if (paid != 0) {
            poolManager.sync(Currency.wrap(address(oldToken)));
            oldToken.safeTransfer(address(poolManager), paid);
            poolManager.settle();
        }
        if (received != 0) poolManager.take(Currency.wrap(address(quote)), address(this), received);
        return abi.encode(paid, received);
    }

    // ---------------- settlement ----------------
    function settle(bytes32 tokenSalt) external nonReentrant returns (address token) {
        if (!canSettle()) revert InvalidState();
        Replacement memory r = replacement;
        token = launchFactory.launch(launchParams(tokenSalt), r.configId, address(quote));
        (address curve,,,) = launchFactory.launchRouting(token);
        quote.forceApprove(curve, proceeds);
        (uint256 tokensOut, uint256 used) = BondingCurve(curve).buy(proceeds, 1, address(this), block.timestamp);
        quote.forceApprove(curve, 0);
        replacementToken = token;
        replacementTotal = tokensOut;
        leftoverQuote = proceeds - used;
        settledAt = uint64(block.timestamp);
        phase = Phase.Settled;
        emit SettledReplacement(token, used, tokensOut, leftoverQuote);
        emit PhaseChanged(phase);
    }

    /// @notice Anyone may fail a migration that cannot settle under its published terms.
    function fail() external {
        if (phase != Phase.Selling) revert InvalidState();
        bool salesOver = sold == totalDeposited || block.timestamp > rules.saleDeadline;
        if (!(block.timestamp > rules.settleDeadline || (salesOver && proceeds < rules.minProceeds)
            || (salesOver && proceeds == 0))) revert InvalidState();
        phase = Phase.Failed;
        emit PhaseChanged(phase);
    }

    // ---------------- claims ----------------
    function claimable(address account) public view returns (uint256) {
        if (phase != Phase.Settled || claimsClosed || totalCredits == 0) return 0;
        uint256 share = Math.mulDiv(replacementTotal, creditsOf[account], totalCredits);
        uint256 elapsed = block.timestamp - settledAt;
        uint256 vested = rules.vestingDuration == 0 || elapsed >= rules.vestingDuration
            ? share : Math.mulDiv(share, elapsed, rules.vestingDuration);
        return vested - claimed[account];
    }

    function claim() external nonReentrant returns (uint256 amount) {
        if (phase != Phase.Settled || claimsClosed || block.timestamp > settledAt + CLAIM_WINDOW) revert InvalidState();
        amount = claimable(msg.sender);
        if (amount == 0) revert InvalidAmount();
        _harvest();
        claimed[msg.sender] += amount;
        IERC20(replacementToken).safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function _harvest() private {
        uint256 pending = LaunchToken(replacementToken).claimable(address(this));
        if (pending != 0) rewardPot += LaunchToken(replacementToken).claimRewards(address(this));
    }

    function harvestRewards() external nonReentrant {
        if (phase != Phase.Settled) revert InvalidState();
        _harvest();
    }

    function rewardsClaimable(address account) public view returns (uint256) {
        if (phase != Phase.Settled || totalCredits == 0) return 0;
        uint256 pot = rewardPot;
        if (!claimsClosed) pot += LaunchToken(replacementToken).claimable(address(this));
        return Math.mulDiv(pot, creditsOf[account], totalCredits) - rewardsPaid[account];
    }

    function claimRewards() external nonReentrant returns (uint256 amount) {
        if (phase != Phase.Settled) revert InvalidState();
        if (!claimsClosed) _harvest();
        amount = Math.mulDiv(rewardPot, creditsOf[msg.sender], totalCredits) - rewardsPaid[msg.sender];
        rewardsPaid[msg.sender] += amount;
        if (amount != 0) quote.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice After the 90-day window, anyone burns unclaimed replacement tokens.
    function closeClaims() external nonReentrant {
        if (phase != Phase.Settled || claimsClosed || block.timestamp <= settledAt + CLAIM_WINDOW) revert InvalidState();
        _harvest();
        claimsClosed = true;
        uint256 remaining = IERC20(replacementToken).balanceOf(address(this));
        if (remaining != 0) IERC20(replacementToken).safeTransfer(BURN, remaining);
        emit ClaimsClosed(remaining);
    }

    // ---------------- refunds and leftovers (separate legs) ----------------
    function unsoldShare(address account) public view returns (uint256) {
        if ((phase != Phase.Settled && phase != Phase.Failed) || oldLegWithdrawn[account] || totalDeposited == 0) return 0;
        return Math.mulDiv(totalDeposited - sold, depositedOf[account], totalDeposited);
    }

    function quoteShare(address account) public view returns (uint256) {
        if ((phase != Phase.Settled && phase != Phase.Failed) || quoteLegWithdrawn[account] || totalDeposited == 0) return 0;
        return Math.mulDiv(phase == Phase.Failed ? proceeds : leftoverQuote, depositedOf[account], totalDeposited);
    }

    function withdrawUnsold() external nonReentrant returns (uint256 amount) {
        amount = unsoldShare(msg.sender);
        if (amount == 0) revert InvalidAmount();
        oldLegWithdrawn[msg.sender] = true;
        oldToken.safeTransfer(msg.sender, amount);
        emit LegWithdrawn(msg.sender, address(oldToken), amount);
    }

    function withdrawQuote() external nonReentrant returns (uint256 amount) {
        amount = quoteShare(msg.sender);
        if (amount == 0) revert InvalidAmount();
        quoteLegWithdrawn[msg.sender] = true;
        quote.safeTransfer(msg.sender, amount);
        emit LegWithdrawn(msg.sender, address(quote), amount);
    }
}
