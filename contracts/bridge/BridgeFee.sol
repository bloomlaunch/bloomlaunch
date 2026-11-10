// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Fee settings shared by both bridge contracts: a fee in basis points of the amount bridged,
/// capped in code, paid to `feeRecipient`. The bridges hold nothing between transactions.
abstract contract BridgeFee is Ownable2Step {
    uint256 public constant MAX_FEE_BPS = 50;   // 0.5%: the owner can never charge more
    uint256 public feeBps;
    address public feeRecipient;

    error InvalidParameters();
    error TransferFailed();
    event FeeChanged(uint256 feeBps, address feeRecipient);

    constructor(address owner_, address feeRecipient_, uint256 feeBps_) Ownable(owner_) {
        _setFee(feeBps_, feeRecipient_);
    }

    function setFee(uint256 feeBps_, address feeRecipient_) external onlyOwner { _setFee(feeBps_, feeRecipient_); }

    function _setFee(uint256 feeBps_, address feeRecipient_) private {
        if (feeBps_ > MAX_FEE_BPS || feeRecipient_ == address(0)) revert InvalidParameters();
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
        emit FeeChanged(feeBps_, feeRecipient_);
    }

    /// @notice The fee on `amount` and what is bridged after it.
    function quote(uint256 amount) public view returns (uint256 fee, uint256 net) {
        fee = amount * feeBps / 10_000;
        net = amount - fee;
    }

    function _payNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
