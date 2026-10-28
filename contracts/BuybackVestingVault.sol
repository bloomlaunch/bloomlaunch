// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBuybackFactory {
    function buybackVault() external view returns (address);
    function isFeeSource(address token, address source) external view returns (bool);
    function launchQuote(address token) external view returns (address);
    function creatorRecipient(address token) external view returns (address);
    function buybacksEnabled(address token) external view returns (bool);
}

/// @dev Production adapter must derive limits from manipulation-resistant market
/// observations and cap price impact. It must use only the canonical market and
/// must not recursively allocate another buyback fee. No caller-selected route.
interface IBuybackAdapter {
    function limits(address token, address quote, uint256 amount)
        external view returns (uint256 minTokens, uint256 maxInput);
    function swap(address token, address quote, uint256 amount, uint256 minTokens,
        address recipient, uint256 deadline) external;
}

/// @notice No owner withdrawals. Quote balances and vesting rights belong to the
/// beneficiary at funding/execution time, not a future token creator recipient.
contract BuybackVestingVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant VESTING_DURATION = 5 * 365 days;
    uint256 public constant EXECUTION_COOLDOWN = 60;
    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;
    uint256 public constant MAX_CLAIM_LOTS = 100;
    struct VestingLot { uint256 amount; uint256 released; uint64 start; }
    address public immutable bootstrapper;
    IBuybackAdapter public immutable adapter;
    IBuybackFactory public factory;
    mapping(address token => address quote) public quoteAssets;
    mapping(address token => mapping(address beneficiary => uint256 amount)) public pending;
    mapping(address quote => uint256 amount) public quoteLiabilities;
    mapping(address token => uint256 amount) public tokenLiabilities;
    mapping(address token => uint256 timestamp) public lastExecution;
    mapping(address token => mapping(address beneficiary => VestingLot[])) private lots;
    error Unauthorized();
    error InvalidParameters();
    error UnsupportedAsset();
    error InvalidExecution();
    error Cooldown();
    error BuybacksStillEnabled();
    event FactoryBound(address indexed factory);
    event Funded(address indexed token, address indexed quote, address indexed beneficiary, uint256 amount);
    event BuybackExecuted(address indexed token, address indexed beneficiary, uint256 quoteSpent, uint256 tokensBought, uint256 lotId);
    event PendingWithdrawn(address indexed token, address indexed beneficiary, address indexed recipient, uint256 amount);
    event VestedClaimed(address indexed token, address indexed beneficiary, address indexed recipient, uint256 amount, uint256 start, uint256 count);

    constructor(address bootstrapper_, address adapter_) {
        if (bootstrapper_ == address(0) || adapter_.code.length == 0) revert InvalidParameters();
        bootstrapper = bootstrapper_;
        adapter = IBuybackAdapter(adapter_);
    }

    /// @notice Resolves deployment ordering once, permanently. This authority
    /// cannot replace the factory, adapter, vesting schedule, or beneficiaries.
    function bindFactory(address factory_) external {
        if (msg.sender != bootstrapper || address(factory) != address(0)) revert Unauthorized();
        if (factory_.code.length == 0 || IBuybackFactory(factory_).buybackVault() != address(this)) revert InvalidParameters();
        factory = IBuybackFactory(factory_);
        emit FactoryBound(factory_);
    }

    function deposit(address token, address quote, address beneficiary, uint256 amount) external nonReentrant {
        if (address(factory) == address(0) || !factory.isFeeSource(token, msg.sender)) revert Unauthorized();
        if (amount == 0 || beneficiary == address(0) || token == quote
            || factory.launchQuote(token) != quote || factory.creatorRecipient(token) != beneficiary
            || !factory.buybacksEnabled(token)) revert InvalidParameters();
        address existing = quoteAssets[token];
        if (existing != address(0) && existing != quote) revert InvalidParameters();
        uint256 beforeBalance = IERC20(quote).balanceOf(address(this));
        IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(quote).balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedAsset();
        quoteAssets[token] = quote;
        pending[token][beneficiary] += amount;
        quoteLiabilities[quote] += amount;
        emit Funded(token, quote, beneficiary, amount);
    }

    /// @notice Anyone may pay gas to execute, but cannot choose prices, routes,
    /// recipients or vesting terms. Failed executions leave funding untouched.
    function execute(address token, address beneficiary, uint256 amount, uint256 deadline)
        external nonReentrant returns (uint256 tokensBought)
    {
        if (address(factory) == address(0) || !factory.buybacksEnabled(token)) revert InvalidParameters();
        if (amount == 0 || amount > pending[token][beneficiary] || deadline < block.timestamp
            || deadline > block.timestamp + MAX_DEADLINE_DELAY) revert InvalidParameters();
        uint256 previous = lastExecution[token];
        if (previous != 0 && block.timestamp < previous + EXECUTION_COOLDOWN) revert Cooldown();
        address quote = quoteAssets[token];
        (uint256 minTokens, uint256 maxInput) = adapter.limits(token, quote, amount);
        if (minTokens == 0 || amount > maxInput) revert InvalidExecution();
        pending[token][beneficiary] -= amount;
        quoteLiabilities[quote] -= amount;
        lastExecution[token] = block.timestamp;
        uint256 quoteBefore = IERC20(quote).balanceOf(address(this));
        uint256 tokensBefore = IERC20(token).balanceOf(address(this));
        IERC20(quote).forceApprove(address(adapter), amount);
        adapter.swap(token, quote, amount, minTokens, address(this), deadline);
        IERC20(quote).forceApprove(address(adapter), 0);
        uint256 quoteAfter = IERC20(quote).balanceOf(address(this));
        uint256 tokensAfter = IERC20(token).balanceOf(address(this));
        if (quoteAfter > quoteBefore || quoteBefore - quoteAfter != amount
            || tokensAfter < tokensBefore || tokensAfter - tokensBefore < minTokens) revert InvalidExecution();
        tokensBought = tokensAfter - tokensBefore;
        tokenLiabilities[token] += tokensBought;
        uint256 lotId = lots[token][beneficiary].length;
        lots[token][beneficiary].push(VestingLot(tokensBought, 0, uint64(block.timestamp)));
        emit BuybackExecuted(token, beneficiary, amount, tokensBought, lotId);
    }

    /// @notice Turning off optional buybacks releases unused funding to its
    /// original beneficiary. A takeover cannot confiscate the old funding.
    function withdrawPending(address token, address recipient) external nonReentrant returns (uint256 amount) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidParameters();
        if (factory.creatorRecipient(token) == msg.sender && factory.buybacksEnabled(token)) revert BuybacksStillEnabled();
        amount = pending[token][msg.sender];
        pending[token][msg.sender] = 0;
        address quote = quoteAssets[token];
        if (amount != 0) {
            quoteLiabilities[quote] -= amount;
            IERC20(quote).safeTransfer(recipient, amount);
        }
        emit PendingWithdrawn(token, msg.sender, recipient, amount);
    }

    function lotCount(address token, address beneficiary) external view returns (uint256) {
        return lots[token][beneficiary].length;
    }
    function vestingLot(address token, address beneficiary, uint256 index) external view returns (VestingLot memory) {
        return lots[token][beneficiary][index];
    }
    function vested(address token, address beneficiary, uint256 index) public view returns (uint256) {
        VestingLot memory lot = lots[token][beneficiary][index];
        uint256 elapsed = block.timestamp - lot.start;
        if (elapsed >= VESTING_DURATION) return lot.amount;
        return Math.mulDiv(lot.amount, elapsed, VESTING_DURATION);
    }
    function claimable(address token, address beneficiary, uint256 start, uint256 count) public view returns (uint256 amount) {
        _range(token, beneficiary, start, count);
        for (uint256 i = start; i < start + count; ++i) {
            amount += vested(token, beneficiary, i) - lots[token][beneficiary][i].released;
        }
    }
    function claimVested(address token, address beneficiary, uint256 start, uint256 count, address recipient)
        external nonReentrant returns (uint256 amount)
    {
        if (recipient == address(0) || recipient == address(this)
            || (msg.sender != beneficiary && recipient != beneficiary)) revert Unauthorized();
        _range(token, beneficiary, start, count);
        for (uint256 i = start; i < start + count; ++i) {
            VestingLot storage lot = lots[token][beneficiary][i];
            uint256 unlocked = vested(token, beneficiary, i);
            amount += unlocked - lot.released;
            lot.released = unlocked;
        }
        if (amount != 0) {
            tokenLiabilities[token] -= amount;
            IERC20(token).safeTransfer(recipient, amount);
        }
        emit VestedClaimed(token, beneficiary, recipient, amount, start, count);
    }
    function _range(address token, address beneficiary, uint256 start, uint256 count) private view {
        uint256 length = lots[token][beneficiary].length;
        if (count > MAX_CLAIM_LOTS || start > length || count > length - start) revert InvalidParameters();
    }
}
