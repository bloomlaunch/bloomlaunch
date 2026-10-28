// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Deposits are credited only when backed by actual received assets.
/// No owner, rescue function, or administrator can spend beneficiary balances.
contract FeeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    mapping(address asset => mapping(address beneficiary => uint256)) public balances;
    mapping(address asset => uint256) public liabilities;
    error InvalidRecipient();
    error UnsupportedAsset();
    error NativeTransferFailed();
    event Credited(address indexed asset, address indexed beneficiary, uint256 amount);
    event Claimed(address indexed asset, address indexed beneficiary, address indexed recipient, uint256 amount);

    function depositNative(address beneficiary) external payable nonReentrant {
        _credit(address(0), beneficiary, msg.value);
    }

    function depositToken(address asset, address beneficiary, uint256 amount) external nonReentrant {
        if (asset == address(0)) revert UnsupportedAsset();
        IERC20 token = IERC20(asset);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedAsset();
        _credit(asset, beneficiary, amount);
    }

    function _credit(address asset, address beneficiary, uint256 amount) private {
        if (beneficiary == address(0)) revert InvalidRecipient();
        balances[asset][beneficiary] += amount;
        liabilities[asset] += amount;
        emit Credited(asset, beneficiary, amount);
    }

    function claim(address asset, address payable recipient) external nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidRecipient();
        amount = balances[asset][msg.sender];
        balances[asset][msg.sender] = 0;
        liabilities[asset] -= amount;
        if (asset == address(0)) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
        emit Claimed(asset, msg.sender, recipient, amount);
    }
}
