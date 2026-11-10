// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IOwned { function owner() external view returns (address); }

/// @notice Upgrade hook shared by the BloomLaunch core contracts. Each one runs behind an ERC-1967
/// proxy; only `_upgrader()` may upgrade it. Core contracts return the factory owner, so moving
/// factory ownership (for example to a Safe or a timelock) moves every upgrade right with it.
/// Tokens and bonding curves are never proxied: once launched, a coin's rules cannot change.
/// Deployed without a proxy (as in some tests), a contract works normally and cannot be upgraded.
abstract contract CoreUpgradeable is UUPSUpgradeable {
    error UpgradeUnauthorized();

    /// @dev The account allowed to upgrade this contract right now (zero: nobody).
    function _upgrader() internal view virtual returns (address);

    function _authorizeUpgrade(address) internal view override {
        address upgrader = _upgrader();
        if (upgrader == address(0) || msg.sender != upgrader) revert UpgradeUnauthorized();
    }

    /// @notice The account allowed to upgrade this contract.
    function upgrader() external view returns (address) { return _upgrader(); }

    /// @dev Owner of an Ownable contract (the factory), or zero if `owned` is unset.
    function _ownerOf(address owned) internal view returns (address) {
        return owned == address(0) ? address(0) : IOwned(owned).owner();
    }
}
