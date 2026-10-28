// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fixed supply with a separate, claimable quote-asset reward ledger.
/// Exclusions are fixed at construction; no mint/admin/blacklist controls exist.
/// Native quote rewards must be wrapped before funding this ledger.
contract LaunchToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e27;
    IERC20 public immutable rewardAsset;
    uint256 public eligibleSupply;
    uint256 public rewardIndex;
    uint256 public pendingRewards;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    mapping(address => bool) public excluded;
    mapping(address => uint256) public paidIndex;
    mapping(address => uint256) private accrued;
    // Sub-token reward precision is preserved across transfers and claims.
    mapping(address => uint256) private fractions;
    error InvalidConfiguration();
    error UnsupportedRewardAsset();
    event RewardsFunded(address indexed sender, uint256 amount);
    event RewardsClaimed(address indexed holder, address indexed recipient, uint256 amount);

    /// @param reserveRecipient Receives `reserveAmount` at deployment; zero for ordinary launches.
    /// Only the platform token (BLOOM) uses a reserve, sent to a vesting contract.
    constructor(string memory name_, string memory symbol_, address inventory,
        uint256 supply, address rewardAsset_, address[] memory exclusions, address reserveRecipient, uint256 reserveAmount)
        ERC20(name_, symbol_)
    {
        if (inventory == address(0) || supply == 0 || rewardAsset_ == address(0)
            || rewardAsset_ == address(this)) revert InvalidConfiguration();
        rewardAsset = IERC20(rewardAsset_);
        excluded[address(0)] = true;
        excluded[address(0xdead)] = true;
        excluded[address(this)] = true;
        excluded[inventory] = true;
        for (uint256 i; i < exclusions.length; ++i) excluded[exclusions[i]] = true;
        _mint(inventory, supply);
        if (reserveAmount != 0) _mint(reserveRecipient, reserveAmount);
    }

    function _settle(address account) private {
        if (excluded[account]) return;
        uint256 delta = rewardIndex - paidIndex[account];
        uint256 balance = balanceOf(account);
        uint256 whole = Math.mulDiv(balance, delta, SCALE);
        uint256 remainder = mulmod(balance, delta, SCALE) + fractions[account];
        accrued[account] += whole + remainder / SCALE;
        fractions[account] = remainder % SCALE;
        paidIndex[account] = rewardIndex;
    }

    function _update(address from, address to, uint256 value) internal override {
        _settle(from);
        _settle(to);
        super._update(from, to, value);
        if (!excluded[from]) eligibleSupply -= value;
        if (!excluded[to]) eligibleSupply += value;
        _distribute();
    }

    function fundRewards(uint256 amount) external nonReentrant {
        uint256 beforeBalance = rewardAsset.balanceOf(address(this));
        rewardAsset.safeTransferFrom(msg.sender, address(this), amount);
        if (rewardAsset.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedRewardAsset();
        pendingRewards += amount;
        totalFunded += amount;
        _distribute();
        emit RewardsFunded(msg.sender, amount);
    }

    function _distribute() private {
        if (eligibleSupply == 0 || pendingRewards == 0) return;
        uint256 increment = Math.mulDiv(pendingRewards, SCALE, eligibleSupply);
        if (increment == 0) return;
        rewardIndex += increment;
        // Index truncation dust remains in this contract, backing unpaid rewards.
        // Do not redistribute rounded dust, which could double-count fractions.
        pendingRewards = 0;
    }

    function claimable(address account) public view returns (uint256) {
        if (excluded[account]) return 0;
        uint256 delta = rewardIndex - paidIndex[account];
        uint256 balance = balanceOf(account);
        return accrued[account] + Math.mulDiv(balance, delta, SCALE)
            + (mulmod(balance, delta, SCALE) + fractions[account]) / SCALE;
    }

    function claimRewards(address recipient) external nonReentrant returns (uint256 amount) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidConfiguration();
        _settle(msg.sender);
        amount = accrued[msg.sender];
        accrued[msg.sender] = 0;
        totalClaimed += amount;
        rewardAsset.safeTransfer(recipient, amount);
        emit RewardsClaimed(msg.sender, recipient, amount);
    }
}
