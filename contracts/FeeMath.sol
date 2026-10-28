// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library FeeMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PLATFORM_BPS = 20;
    uint256 internal constant MAX_CREATOR_BPS = 1_000;
    error InvalidFee();
    error InvalidAllocation();

    function fees(uint256 gross, uint256 creatorBps)
        internal pure returns (uint256 platform, uint256 creator, uint256 net)
    {
        if (creatorBps > MAX_CREATOR_BPS) revert InvalidFee();
        platform = Math.mulDiv(gross, PLATFORM_BPS, BPS);
        creator = Math.mulDiv(gross, creatorBps, BPS);
        net = gross - platform - creator;
    }

    /// @notice Smallest gross amount whose post-fee net covers `net`.
    function grossForNet(uint256 net, uint256 creatorBps) internal pure returns (uint256 gross) {
        if (creatorBps > MAX_CREATOR_BPS) revert InvalidFee();
        gross = Math.mulDiv(net, BPS, BPS - PLATFORM_BPS - creatorBps, Math.Rounding.Ceil);
        // Separate floor-rounded fees make the conservative inversion at most
        // three quote units too large (combined rate is bounded at 10.20%).
        while (gross > 0) {
            (,, uint256 previousNet) = fees(gross - 1, creatorBps);
            if (previousNet < net) break;
            --gross;
        }
    }

    function allocate(uint256 creatorFee, uint256 holderBps, uint256 buybackBps)
        internal pure returns (uint256 creator, uint256 holders, uint256 buyback)
    {
        if (holderBps > BPS || buybackBps > BPS - holderBps) revert InvalidAllocation();
        holders = Math.mulDiv(creatorFee, holderBps, BPS);
        buyback = Math.mulDiv(creatorFee, buybackBps, BPS);
        creator = creatorFee - holders - buyback;
    }
}
