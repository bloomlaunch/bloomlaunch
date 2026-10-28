// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

/// @notice Holds the team's BLOOM reserve. `immediateBps` of it is unlocked from the
/// start (the team may release and sell it at any time); the rest releases linearly
/// from `start` over `duration` (12 months at launch). Anyone may call release(token);
/// funds can only ever go to the current beneficiary.
contract TeamVesting is VestingWallet {
    /// @notice Share of the reserve unlocked immediately, in basis points (5000 = 50%).
    uint256 public immutable immediateBps;

    error InvalidImmediateShare();

    constructor(address beneficiary, uint64 start, uint64 duration, uint256 immediateBps_)
        VestingWallet(beneficiary, start, duration)
    {
        if (immediateBps_ > 10_000) revert InvalidImmediateShare();
        immediateBps = immediateBps_;
    }

    function _vestingSchedule(uint256 totalAllocation, uint64 timestamp) internal view override returns (uint256) {
        uint256 immediate = totalAllocation * immediateBps / 10_000;
        return immediate + super._vestingSchedule(totalAllocation - immediate, timestamp);
    }
}
