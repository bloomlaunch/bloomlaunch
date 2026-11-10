// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BridgeFee} from "./BridgeFee.sol";

/// @dev Arbitrum Nitro Inbox (Elysium's, on HyperEVM).
interface IInbox {
    function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress,
        address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes calldata data) external payable returns (uint256);
    function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) external view returns (uint256);
}

/// @dev Arbitrum Nitro gateway router (Elysium's, on HyperEVM).
interface IGatewayRouter {
    function outboundTransfer(address token, address to, uint256 amount, uint256 maxGas, uint256 gasPriceBid, bytes calldata data)
        external payable returns (bytes memory);
    function getGateway(address token) external view returns (address);
}

/// @notice BloomLaunch bridge, HyperEVM -> Elysium (deploy on HyperEVM). Keeps a small fee and hands the
/// rest to Elysium's official bridge in the same transaction; it never holds funds afterwards.
/// HYPE goes through a retryable ticket to `to` (a plain depositEth from a contract would credit the
/// contract's aliased address instead of the user). Tokens go through the canonical gateway router.
/// Delivery on Elysium takes about a minute; any unused delivery gas is refunded to `to` on Elysium.
contract BridgeIn is BridgeFee, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IInbox public immutable inbox;
    IGatewayRouter public immutable router;

    event BridgedHype(address indexed sender, address indexed to, uint256 amount, uint256 fee, uint256 ticketId);
    event BridgedToken(address indexed sender, address indexed to, address indexed token, uint256 amount, uint256 fee);

    constructor(IInbox inbox_, IGatewayRouter router_, address owner_, address feeRecipient_, uint256 feeBps_)
        BridgeFee(owner_, feeRecipient_, feeBps_)
    {
        if (address(inbox_).code.length == 0 || address(router_).code.length == 0) revert InvalidParameters();
        inbox = inbox_;
        router = router_;
    }

    /// @notice HYPE to send so that at least `amount` arrives on Elysium: the fee on top, the ticket's
    /// submission cost at `parentBaseFee` (pass the latest HyperEVM base fee with a margin: read-only calls
    /// see a base fee of 0; any excess also arrives), and `gasLimit * maxFeePerGas` of Elysium gas (unused
    /// gas is refunded to the user on Elysium).
    function hypeValue(uint256 amount, uint256 gasLimit, uint256 maxFeePerGas, uint256 parentBaseFee)
        external view returns (uint256 value, uint256 fee)
    {
        fee = amount * feeBps / (10_000 - feeBps) + 1;
        uint256 baseFee = parentBaseFee > block.basefee ? parentBaseFee : block.basefee;
        value = amount + fee + inbox.calculateRetryableSubmissionFee(0, baseFee) + gasLimit * maxFeePerGas;
    }

    /// @notice Bridge HYPE to `to` on Elysium. `msg.value` = amount + fee + submission cost + gas;
    /// `amount` (what arrives) is msg.value minus those, and its fee is `feeBps` of the total bridged.
    function depositHype(address to, uint256 gasLimit, uint256 maxFeePerGas) external payable nonReentrant returns (uint256 ticketId) {
        if (to == address(0) || gasLimit == 0 || maxFeePerGas == 0) revert InvalidParameters();
        uint256 submission = inbox.calculateRetryableSubmissionFee(0, block.basefee);
        uint256 costs = submission + gasLimit * maxFeePerGas;
        if (msg.value <= costs) revert InvalidParameters();
        (uint256 fee, uint256 amount) = quote(msg.value - costs);
        _payNative(feeRecipient, fee);
        ticketId = inbox.createRetryableTicket{value: amount + costs}(to, amount, submission, to, to, gasLimit, maxFeePerGas, "");
        emit BridgedHype(msg.sender, to, amount, fee, ticketId);
    }

    /// @notice Bridge `amount` of a HyperEVM ERC-20 to `to` on Elysium through the canonical gateway.
    /// The fee is taken in the token; `msg.value` pays the gateway's delivery (maxGas, gasPriceBid and
    /// the submission cost encoded in `data`, as the gateway router expects).
    function depositToken(address token, uint256 amount, address to, uint256 maxGas, uint256 gasPriceBid, bytes calldata data)
        external payable nonReentrant
    {
        if (to == address(0) || amount == 0) revert InvalidParameters();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert InvalidParameters();   // no fee-on-transfer tokens
        (uint256 fee, uint256 net) = quote(amount);
        if (fee > 0) IERC20(token).safeTransfer(feeRecipient, fee);
        address gateway = router.getGateway(token);
        IERC20(token).forceApprove(gateway, net);
        router.outboundTransfer{value: msg.value}(token, to, net, maxGas, gasPriceBid, data);
        IERC20(token).forceApprove(gateway, 0);
        emit BridgedToken(msg.sender, to, token, net, fee);
    }
}
