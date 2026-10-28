// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FeeEscrow} from "./FeeEscrow.sol";

interface IBurnFactory {
    function platformRecipient() external view returns (address);
    function launchRouting(address token) external view
        returns (address curve, address quote, address executor, bytes32 poolId);
}
interface IBurnAdapter {
    function limits(address token, address quote, uint256 amount) external view returns (uint256 minTokens, uint256 maxInput);
    function swap(address token, address quote, uint256 amount, uint256 minTokens, address recipient, uint256 deadline) external;
}

/// @notice The platform fee recipient. Platform revenue is claimed from the fee
/// escrow by anyone; BURN_BPS of revenue in the burn asset (WETH, BLOOM's pair) is
/// set aside to buy BLOOM on its canonical pool and send it to the burn address,
/// and the rest goes to the treasury. Revenue in other quote assets goes to the
/// treasury in full; the treasury may convert it and add it with depositForBurn.
/// Users' trading fees are unchanged: this only directs the platform's own share.
/// Buybacks use the canonical adapter's TWAP limits (no execution while the
/// price is displaced, size capped by liquidity, minimum output enforced).
contract BloomBuybackBurner is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_DEADLINE_DELAY = 5 minutes;
    FeeEscrow public immutable escrow;
    address public immutable treasury;
    address public immutable burnAsset;
    uint16 public immutable burnBps;
    address public immutable bootstrapper;
    IBurnFactory public factory;
    address public bloom;
    IBurnAdapter public adapter;
    uint256 public burnPending;
    uint256 public totalSpent;
    uint256 public totalBurned;
    mapping(address asset => uint256) public toTreasury;

    error Unauthorized();
    error InvalidParameters();
    error InvalidExecution();
    event Bound(address indexed factory, address indexed bloom, address indexed adapter);
    event RevenueClaimed(address indexed asset, uint256 amount, uint256 toBurn, uint256 toTreasury);
    event BurnDeposited(address indexed from, uint256 amount);
    event BloomBurned(address indexed caller, uint256 spent, uint256 bloomBurned);

    constructor(FeeEscrow escrow_, address treasury_, address burnAsset_, uint16 burnBps_, address bootstrapper_) {
        if (address(escrow_) == address(0) || treasury_ == address(0) || burnAsset_ == address(0)
            || burnBps_ > 10_000 || bootstrapper_ == address(0)) revert InvalidParameters();
        escrow = escrow_;
        treasury = treasury_;
        burnAsset = burnAsset_;
        burnBps = burnBps_;
        bootstrapper = bootstrapper_;
    }

    /// @notice One-time binding after BLOOM is launched on the factory. Cannot be changed.
    function bind(address factory_, address bloom_, address adapter_) external {
        if (msg.sender != bootstrapper || bloom != address(0)) revert Unauthorized();
        (address curve, address quote,,) = IBurnFactory(factory_).launchRouting(bloom_);
        if (IBurnFactory(factory_).platformRecipient() != address(this) || curve == address(0)
            || quote != burnAsset || adapter_.code.length == 0) revert InvalidParameters();
        factory = IBurnFactory(factory_);
        bloom = bloom_;
        adapter = IBurnAdapter(adapter_);
        emit Bound(factory_, bloom_, adapter_);
    }

    /// @notice Anyone may pull platform revenue out of the escrow and split it.
    function claim(address asset) external nonReentrant returns (uint256 amount) {
        amount = escrow.claim(asset, payable(address(this)));
        uint256 burnShare = asset == burnAsset ? amount * burnBps / 10_000 : 0;
        uint256 rest = amount - burnShare;
        burnPending += burnShare;
        toTreasury[asset] += rest;
        if (rest != 0) IERC20(asset).safeTransfer(treasury, rest);
        emit RevenueClaimed(asset, amount, burnShare, rest);
    }

    /// @notice Adds burn-asset funds (for example converted revenue) to the next buybacks.
    function depositForBurn(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidParameters();
        uint256 before = IERC20(burnAsset).balanceOf(address(this));
        IERC20(burnAsset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(burnAsset).balanceOf(address(this)) - before;
        burnPending += received;
        emit BurnDeposited(msg.sender, received);
    }

    /// @notice Permissionless buyback within the adapter's TWAP limits; bought BLOOM goes to the burn address.
    function executeBurn(uint256 amount, uint256 deadline) external nonReentrant returns (uint256 burned) {
        if (bloom == address(0) || amount == 0 || amount > burnPending || deadline < block.timestamp
            || deadline > block.timestamp + MAX_DEADLINE_DELAY) revert InvalidParameters();
        (uint256 minTokens, uint256 maxInput) = adapter.limits(bloom, burnAsset, amount);
        if (minTokens == 0 || amount > maxInput) revert InvalidExecution();
        burnPending -= amount;
        uint256 before = IERC20(bloom).balanceOf(BURN);
        IERC20(burnAsset).forceApprove(address(adapter), amount);
        adapter.swap(bloom, burnAsset, amount, minTokens, BURN, deadline);
        IERC20(burnAsset).forceApprove(address(adapter), 0);
        burned = IERC20(bloom).balanceOf(BURN) - before;
        if (burned < minTokens) revert InvalidExecution();
        totalSpent += amount;
        totalBurned += burned;
        emit BloomBurned(msg.sender, amount, burned);
    }
}
