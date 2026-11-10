// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Placeholder implementation every core proxy starts on, so that all proxy addresses exist
/// before the real implementations (which take those addresses as constructor immutables) are
/// deployed. It has no functions besides the upgrade, which only `deployer` may call, once per proxy,
/// to install the real implementation.
contract ProxyBootstrap is UUPSUpgradeable {
    address public immutable deployer;

    error UpgradeUnauthorized();

    constructor(address deployer_) { deployer = deployer_; }

    /// @notice No-op: ERC-1967 proxies must make an initialization call when created.
    function initialize() external {}

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != deployer) revert UpgradeUnauthorized();
    }
}

/// @dev Re-exported so the build produces the standard ERC-1967 proxy artifact.
contract CoreProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) payable ERC1967Proxy(implementation, data) {}
}
