// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BridgeFee} from "./BridgeFee.sol";

/// @dev ArbOS precompile at 0x64 on Elysium.
interface IArbSys { function withdrawEth(address destination) external payable returns (uint256); }

/// @dev Elysium's gateway router (child side).
interface IChildGatewayRouter {
    function outboundTransfer(address l1Token, address to, uint256 amount, bytes calldata data) external payable returns (bytes memory);
}

/// @notice BloomLaunch bridge, Elysium -> HyperEVM (deploy on Elysium). Keeps a small fee and starts the
/// official withdrawal for the rest in the same transaction; it never holds funds afterwards.
/// Withdrawals become claimable on HyperEVM after the challenge period (about 5.5 days on mainnet); the
/// claim is a separate HyperEVM transaction through the Outbox, which anyone can make for the user.
contract BridgeOut is BridgeFee, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IArbSys public constant ARB_SYS = IArbSys(address(0x64));
    IChildGatewayRouter public immutable router;

    event WithdrewHype(address indexed sender, address indexed to, uint256 amount, uint256 fee, uint256 withdrawalId);
    event WithdrewToken(address indexed sender, address indexed to, address indexed childToken, address parentToken, uint256 amount, uint256 fee);

    constructor(IChildGatewayRouter router_, address owner_, address feeRecipient_, uint256 feeBps_) BridgeFee(owner_, feeRecipient_, feeBps_) {
        if (address(router_).code.length == 0) revert InvalidParameters();
        router = router_;
    }

    /// @notice Withdraw HYPE to `to` on HyperEVM; the fee is `feeBps` of msg.value.
    function withdrawHype(address to) external payable nonReentrant returns (uint256 withdrawalId) {
        if (to == address(0) || msg.value == 0) revert InvalidParameters();
        (uint256 fee, uint256 amount) = quote(msg.value);
        _payNative(feeRecipient, fee);
        withdrawalId = ARB_SYS.withdrawEth{value: amount}(to);
        emit WithdrewHype(msg.sender, to, amount, fee, withdrawalId);
    }

    /// @notice Withdraw `amount` of a bridged token (its Elysium representation `childToken`, whose HyperEVM
    /// original is `parentToken`) to `to` on HyperEVM. The gateway burns it from this contract.
    function withdrawToken(address childToken, address parentToken, uint256 amount, address to) external nonReentrant {
        if (to == address(0) || amount == 0) revert InvalidParameters();
        uint256 before = IERC20(childToken).balanceOf(address(this));
        IERC20(childToken).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(childToken).balanceOf(address(this)) - before != amount) revert InvalidParameters();
        (uint256 fee, uint256 net) = quote(amount);
        if (fee > 0) IERC20(childToken).safeTransfer(feeRecipient, fee);
        router.outboundTransfer(parentToken, to, net, "");
        if (IERC20(childToken).balanceOf(address(this)) != before) revert InvalidParameters();   // the gateway burned exactly `net`
        emit WithdrewToken(msg.sender, to, childToken, parentToken, net, fee);
    }
}
