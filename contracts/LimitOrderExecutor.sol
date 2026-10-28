// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {LaunchRouter} from "./LaunchRouter.sol";

interface ILimitFactory {
    function launchRouting(address token) external view
        returns (address curve, address quote, address executor, bytes32 poolId);
}

/// @notice Gasless limit orders. A maker signs an EIP-712 order offline and approves
/// this contract for the input asset; anyone (normally the keeper) may fill it once
/// the market gives at least `minAmountOut`. Fills are all-or-nothing, go through the
/// normal router (same fees as any trade) and pay the output straight to the maker.
/// The filler cannot change amounts, prices or recipients. Makers cancel by nonce.
contract LimitOrderExecutor is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address maker;
        address token;
        bool buy;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 expiry;
        uint256 nonce;
    }
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address token,bool buy,uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)");

    LaunchRouter public immutable router;
    ILimitFactory public immutable factory;
    mapping(address maker => mapping(uint256 nonce => bool)) public nonceUsed;

    error InvalidOrder();
    event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed token, bool buy,
        uint256 amountIn, uint256 amountOut, address filler);
    event OrderCancelled(address indexed maker, uint256 nonce);

    constructor(LaunchRouter router_) EIP712("BloomLaunch Limit Orders", "1") {
        router = router_;
        factory = ILimitFactory(address(router_.factory()));
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, o.maker, o.token, o.buy, o.amountIn,
            o.minAmountOut, o.expiry, o.nonce)));
    }

    function cancel(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    function fill(Order calldata o, bytes calldata signature) external nonReentrant returns (uint256 amountOut) {
        bytes32 digest = hashOrder(o);
        if (block.timestamp > o.expiry || o.amountIn == 0 || o.minAmountOut == 0 || nonceUsed[o.maker][o.nonce]
            || !SignatureChecker.isValidSignatureNow(o.maker, digest, signature)) revert InvalidOrder();
        nonceUsed[o.maker][o.nonce] = true;
        (, address quote,,) = factory.launchRouting(o.token);
        if (quote == address(0)) revert InvalidOrder();
        if (o.buy) {
            IERC20(quote).safeTransferFrom(o.maker, address(this), o.amountIn);
            IERC20(quote).forceApprove(address(router), o.amountIn);
            uint256 used;
            (amountOut, used) = router.buy(o.token, o.amountIn, o.minAmountOut, o.maker, block.timestamp);
            IERC20(quote).forceApprove(address(router), 0);
            // A capped final curve buy refunds unused input; return it to the maker.
            if (used < o.amountIn) IERC20(quote).safeTransfer(o.maker, o.amountIn - used);
        } else {
            IERC20(o.token).safeTransferFrom(o.maker, address(this), o.amountIn);
            IERC20(o.token).forceApprove(address(router), o.amountIn);
            amountOut = router.sell(o.token, o.amountIn, o.minAmountOut, o.maker, block.timestamp, false);
            IERC20(o.token).forceApprove(address(router), 0);
        }
        emit OrderFilled(digest, o.maker, o.token, o.buy, o.amountIn, amountOut, msg.sender);
    }
}
