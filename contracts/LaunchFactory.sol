// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchDeployer} from "./LaunchDeployer.sol";

interface IGraduationExecutor {
    function execute(address token, address quote, uint256 tokens, uint256 quoteAmount) external returns (bytes32 poolId);
    function isLocked(bytes32 poolId) external view returns (bool);
    /// @notice Canonical post-graduation fee hook, or zero if none collects fees.
    function feeHook() external view returns (address);
}

contract LaunchFactory is Ownable2Step, ReentrancyGuard {
    struct QuoteAsset { bool approved; uint8 decimals; }
    struct Config {
        uint128 supply;
        uint128 reservedTokens;
        uint128 phantomQuote;
        address quote;
        address executor;
        bool enabled;
    }
    struct Params {
        string name;
        string symbol;
        string metadataURI;
        address creatorRecipient;
        uint16 creatorBps;
        uint16 holderShareBps;
        uint16 buybackShareBps;
        bytes32 salt;
        bytes32 expectedEconomics;
        /// @notice Searched by the client so the token address ends in TOKEN_SUFFIX.
        bytes32 tokenSalt;
        /// @notice Opening snipe protection: per-wallet buy cap for the first minutes.
        bool launchProtection;
        /// @notice Up to 32 wallets exempt from opening protection; public onchain.
        address[] protectionExempt;
    }
    struct Launch {
        address creator;
        address curve;
        address quote;
        address executor;
        uint256 configId;
        bytes32 poolId;
        string metadataURI;
    }
    struct Takeover { address recipient; uint64 executableAt; uint64 expiresAt; }
    uint256 public constant TAKEOVER_DELAY = 3 days;
    uint256 public constant TAKEOVER_WINDOW = 3 days;
    /// @notice Maximum relative difference between terminal curve and opening pool price.
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 1;
    /// @notice Every BloomLaunch token address ends in hex b00b ("BOOB"), like a brand mark.
    uint160 public constant TOKEN_SUFFIX = 0xb00b;
    uint160 public constant TOKEN_SUFFIX_MASK = 0xffff;
    address public immutable platformRecipient;
    address public immutable buybackVault;
    address public immutable escrow;
    address public immutable poolManager;
    address public immutable locker;
    LaunchDeployer public immutable deployer;
    mapping(address => QuoteAsset) public quoteAssets;
    Config[] public configs;
    mapping(address => Launch) public launches;
    mapping(address => Takeover) public takeovers;
    /// @notice One-time bound launch router allowed to launch on a creator's behalf.
    address public router;
    /// @notice The platform token (BLOOM), the only launch allowed a team reserve.
    address public platformToken;
    /// @notice Maximum team reserve of the platform token: 10% of total supply.
    uint256 public constant MAX_RESERVE_BPS = 1_000;
    error InvalidParameters();
    error EconomicsChanged();
    error Unauthorized();
    error InvalidState();
    error TokenSuffix();
    event QuoteAssetConfigured(address indexed asset, bool approved, uint8 decimals);
    event ConfigAdded(uint256 indexed configId);
    event ConfigEnabled(uint256 indexed configId, bool enabled);
    event TokenLaunched(address indexed token, address indexed curve, address indexed creator, address quote, uint256 configId);
    event Graduated(address indexed token, bytes32 indexed poolId);
    event CreatorTransferred(address indexed token, address indexed previousRecipient, address indexed nextRecipient);
    event TakeoverProposed(address indexed token, address indexed recipient, uint256 executableAt, uint256 expiresAt);
    event TakeoverCancelled(address indexed token);
    event BuybacksChanged(address indexed token, bool enabled, address indexed caller);
    event RouterBound(address indexed router);
    event ProtectionEnded(address indexed token, address indexed caller);
    event PlatformTokenLaunched(address indexed token, address indexed reserveRecipient, uint256 reserveAmount);

    constructor(address governor, address platform, address escrow_, address buyback,
        address poolManager_, address locker_) Ownable(governor)
    {
        if (platform == address(0) || escrow_ == address(0) || buyback == address(0)
            || poolManager_ == address(0) || locker_ == address(0)) revert InvalidParameters();
        platformRecipient = platform; escrow = escrow_; buybackVault = buyback;
        poolManager = poolManager_; locker = locker_;
        deployer = new LaunchDeployer(address(this));
    }

    function configureQuote(address asset, bool approved) external onlyOwner {
        if (asset.code.length == 0) revert InvalidParameters();
        uint8 decimals = IERC20Metadata(asset).decimals();
        if (decimals > 18) revert InvalidParameters();
        quoteAssets[asset] = QuoteAsset(approved, decimals);
        emit QuoteAssetConfigured(asset, approved, decimals);
    }

    function addConfig(Config calldata c) external onlyOwner returns (uint256 id) {
        if (c.supply == 0 || c.reservedTokens == 0 || c.reservedTokens >= c.supply / 2
            || c.phantomQuote == 0 || c.executor.code.length == 0 || !quoteAssets[c.quote].approved) revert InvalidParameters();
        id = configs.length;
        configs.push(c);
        emit ConfigAdded(id);
    }
    function setConfigEnabled(uint256 id, bool enabled) external onlyOwner {
        configs[id].enabled = enabled;
        emit ConfigEnabled(id, enabled);
    }
    function configCount() external view returns (uint256) { return configs.length; }

    /// @notice Binds the launch router once. It cannot be replaced or removed, and
    /// can only attribute launches to the creator that called it.
    function bindRouter(address router_) external onlyOwner {
        if (router != address(0) || router_.code.length == 0) revert InvalidParameters();
        router = router_;
        emit RouterBound(router_);
    }

    function previewEconomics(uint256 id, address quote) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, configs[id], quote,
            quoteAssets[quote], platformRecipient, escrow, buybackVault, poolManager, locker, uint16(20)));
    }

    // Nonpayable: the factory cannot collect a native launch fee.
    function launch(Params calldata p, uint256 id, address quote) external nonReentrant returns (address tokenAddress) {
        return _launch(msg.sender, p, id, quote, address(0), 0);
    }

    /// @notice Launches the platform token once, with at most 10% of total supply minted to
    /// `reserveRecipient` (a vesting contract). The rest trades on the curve like any launch.
    function launchPlatformToken(Params calldata p, uint256 id, address quote, address reserveRecipient, uint256 reserveAmount)
        external onlyOwner nonReentrant returns (address tokenAddress)
    {
        Config memory c = configs[id];
        if (platformToken != address(0) || reserveRecipient.code.length == 0 || reserveAmount == 0
            || reserveAmount * 10_000 > (uint256(c.supply) + reserveAmount) * MAX_RESERVE_BPS) revert InvalidParameters();
        tokenAddress = _launch(msg.sender, p, id, quote, reserveRecipient, reserveAmount);
        platformToken = tokenAddress;
        emit PlatformTokenLaunched(tokenAddress, reserveRecipient, reserveAmount);
    }

    /// @notice Router entry point; CREATE2 salts and attribution stay scoped to the creator.
    function launchFor(address creator, Params calldata p, uint256 id, address quote)
        external nonReentrant returns (address tokenAddress)
    {
        if (msg.sender != router || router == address(0)) revert Unauthorized();
        if (creator == address(0)) revert InvalidParameters();
        return _launch(creator, p, id, quote, address(0), 0);
    }

    function predictToken(address creator, Params calldata p, uint256 id, address quote) external view returns (address) {
        Config memory c = configs[id];
        bytes32 salt = keccak256(abi.encode(creator, p.salt));
        (address token,) = deployer.predict(salt, p.tokenSalt, p.name, p.symbol, _settings(p, c, quote), _exclusions(c));
        return token;
    }

    /// @notice Curve address and token init-code hash for client-side suffix search:
    /// token = CREATE2(deployer, tokenSalt, initHash) must end in TOKEN_SUFFIX.
    function tokenInitHash(address creator, Params calldata p, uint256 id, address quote)
        external view returns (address deployerAddress, address curve, bytes32 initHash)
    {
        return reserveTokenInitHash(creator, p, id, quote, address(0), 0);
    }

    function reserveTokenInitHash(address creator, Params calldata p, uint256 id, address quote,
        address reserveRecipient, uint256 reserveAmount) public view returns (address deployerAddress, address curve, bytes32 initHash)
    {
        (curve, initHash) = deployer.tokenInitHash(keccak256(abi.encode(creator, p.salt)), p.name, p.symbol,
            _settings(p, configs[id], quote), _exclusions(configs[id]), reserveRecipient, reserveAmount);
        deployerAddress = address(deployer);
    }

    function _settings(Params calldata p, Config memory c, address quote) private view returns (BondingCurve.Settings memory) {
        return BondingCurve.Settings(address(this), quote, escrow, platformRecipient, p.creatorRecipient,
            buybackVault, c.supply, c.reservedTokens, c.phantomQuote, p.creatorBps, p.holderShareBps, p.buybackShareBps,
            p.launchProtection);
    }

    /// @dev Contracts that hold launch tokens for others never earn holder rewards. The router
    /// is included because it holds a seller's tokens while the pool's fee hook funds rewards.
    function _exclusions(Config memory c) private view returns (address[] memory exclusions) {
        exclusions = new address[](8);
        exclusions[0] = poolManager; exclusions[1] = locker; exclusions[2] = escrow;
        exclusions[3] = buybackVault; exclusions[4] = address(this);
        exclusions[5] = address(deployer); exclusions[6] = c.executor; exclusions[7] = router;
    }

    function _launch(address creator, Params calldata p, uint256 id, address quote, address reserveRecipient, uint256 reserveAmount)
        private returns (address tokenAddress)
    {
        if (bytes(p.name).length == 0 || bytes(p.name).length > 64 || bytes(p.symbol).length == 0
            || bytes(p.symbol).length > 16 || bytes(p.metadataURI).length > 512 || p.creatorRecipient == address(0)) revert InvalidParameters();
        Config memory c = configs[id];
        QuoteAsset memory asset = quoteAssets[quote];
        if (!c.enabled || c.quote != quote || !asset.approved || IERC20Metadata(quote).decimals() != asset.decimals) revert InvalidParameters();
        if (p.expectedEconomics != previewEconomics(id, quote)) revert EconomicsChanged();
        bytes32 salt = keccak256(abi.encode(creator, p.salt));
        (LaunchToken token, BondingCurve curve) = deployer.deploy(salt, p.tokenSalt, p.name, p.symbol,
            _settings(p, c, quote), _exclusions(c), reserveRecipient, reserveAmount, p.protectionExempt);
        tokenAddress = address(token);
        if (uint160(tokenAddress) & TOKEN_SUFFIX_MASK != TOKEN_SUFFIX) revert TokenSuffix();
        launches[tokenAddress] = Launch(creator, address(curve), quote, c.executor, id, bytes32(0), p.metadataURI);
        emit TokenLaunched(tokenAddress, address(curve), creator, quote, id);
    }

    function tryGraduate(address token) external nonReentrant returns (bytes32 poolId) {
        Launch storage l = launches[token];
        if (l.curve == address(0) || l.poolId != bytes32(0)) revert InvalidState();
        BondingCurve curve = BondingCurve(l.curve);
        uint256 virtualQuote = curve.quoteReserve();
        uint256 virtualTokens = curve.tokenReserve();
        (uint256 tokens, uint256 quoteAmount) = curve.releaseForGraduation(l.executor);
        // Graduation guard: the opening pool price must continue the curve's terminal price.
        uint256 poolSide = quoteAmount * virtualTokens;
        uint256 curveSide = virtualQuote * tokens;
        uint256 difference = poolSide > curveSide ? poolSide - curveSide : curveSide - poolSide;
        if (tokens == 0 || quoteAmount == 0 || difference * 10_000 > curveSide * MAX_PRICE_DEVIATION_BPS) revert InvalidState();
        poolId = IGraduationExecutor(l.executor).execute(token, l.quote, tokens, quoteAmount);
        if (poolId == bytes32(0) || !IGraduationExecutor(l.executor).isLocked(poolId)) revert InvalidState();
        l.poolId = poolId;
        emit Graduated(token, poolId);
    }

    function creatorRecipient(address token) public view returns (address) {
        Launch memory l = launches[token];
        if (l.curve == address(0)) revert InvalidParameters();
        return BondingCurve(l.curve).creatorRecipient();
    }

    function launchQuote(address token) external view returns (address) { return launches[token].quote; }
    function launchRouting(address token) external view
        returns (address curve, address quote, address executor, bytes32 poolId)
    {
        Launch storage l = launches[token];
        return (l.curve, l.quote, l.executor, l.poolId);
    }
    /// @notice The curve, and after graduation the launch's pinned executor fee hook.
    function isFeeSource(address token, address source) external view returns (bool) {
        Launch storage l = launches[token];
        if (source == address(0) || l.curve == address(0)) return false;
        if (l.curve == source) return true;
        return l.poolId != bytes32(0) && IGraduationExecutor(l.executor).feeHook() == source;
    }
    function buybacksEnabled(address token) external view returns (bool) {
        address curve = launches[token].curve;
        return curve != address(0) && BondingCurve(curve).buybacksEnabled();
    }
    function setBuybacks(address token, bool enabled) external {
        if (msg.sender != creatorRecipient(token)) revert Unauthorized();
        BondingCurve(launches[token].curve).setBuybacksEnabled(enabled);
        emit BuybacksChanged(token, enabled, msg.sender);
    }
    /// @notice Governance can stop optional buybacks but cannot turn them on.
    function disableBuybacks(address token) external onlyOwner {
        address curve = launches[token].curve;
        if (curve == address(0)) revert InvalidParameters();
        BondingCurve(curve).setBuybacksEnabled(false);
        emit BuybacksChanged(token, false, msg.sender);
    }

    /// @notice The creator can end opening protection early; it can never be re-enabled.
    function endProtection(address token) external {
        if (msg.sender != creatorRecipient(token)) revert Unauthorized();
        BondingCurve(launches[token].curve).endProtection();
        emit ProtectionEnded(token, msg.sender);
    }

    function transferCreator(address token, address recipient) external {
        if (msg.sender != creatorRecipient(token)) revert Unauthorized();
        _transferCreator(token, recipient);
    }
    function proposeTakeover(address token, address recipient) external onlyOwner {
        if (launches[token].curve == address(0) || recipient == address(0)) revert InvalidParameters();
        uint64 executableAt = uint64(block.timestamp + TAKEOVER_DELAY);
        uint64 expiresAt = uint64(executableAt + TAKEOVER_WINDOW);
        takeovers[token] = Takeover(recipient, executableAt, expiresAt);
        emit TakeoverProposed(token, recipient, executableAt, expiresAt);
    }
    function cancelTakeover(address token) external onlyOwner {
        delete takeovers[token]; emit TakeoverCancelled(token);
    }
    function executeTakeover(address token) external {
        Takeover memory t = takeovers[token];
        if (t.recipient == address(0) || block.timestamp < t.executableAt || block.timestamp > t.expiresAt) revert InvalidState();
        delete takeovers[token];
        _transferCreator(token, t.recipient);
    }
    function _transferCreator(address token, address recipient) private {
        if (recipient == address(0)) revert InvalidParameters();
        address previous = creatorRecipient(token);
        BondingCurve(launches[token].curve).changeCreator(recipient);
        emit CreatorTransferred(token, previous, recipient);
    }
}
