// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {BondingCurveV2} from "../v2/BondingCurveV2.sol";
import {LaunchToken} from "../LaunchToken.sol";
import {BondingCurveV3} from "./BondingCurveV3.sol";
import {LaunchTokenV3} from "./LaunchTokenV3.sol";

/// @notice v4 deployer: like LaunchDeployerV3 (same interface, same fixed masters, same gas), but each token
/// and curve is a plain 45-byte EIP-1167 clone with no appended data, the form block explorers recognize
/// and link to the master's verified source.
///
/// Address binding: the curve's CREATE2 salt is the hash of its creator-scoped salt and its settings, so a
/// curve address still commits to its launch. The token's salt is the client-searched `tokenSalt` itself
/// (the clone init code is the same for every token), so a client can still search for the b00b suffix
/// against `tokenInitHash`. Someone who copies a pending launch's `tokenSalt` can occupy that one address
/// first; the copied launch then reverts and the creator simply launches again with a new search. Nothing
/// can be taken: a token only ever holds the supply minted to its own curve.
///
/// The masters have no owner and no upgrade path, and clones delegate to them by fixed address, so a
/// launched token and curve can never change.
contract LaunchDeployerV4 {
    address public immutable factory;
    address public immutable curveMaster;
    address public immutable tokenMaster;
    /// @notice Identifies the clone form (used by deployment tooling).
    string public constant CLONE_KIND = "eip1167";
    error Unauthorized();
    error InvalidParameters();

    /// @param curveMaster_ / tokenMaster_ The fixed, verified masters (BondingCurveV3, LaunchTokenV3).
    constructor(address factory_, address curveMaster_, address tokenMaster_) {
        if (factory_ == address(0) || curveMaster_.code.length == 0 || tokenMaster_.code.length == 0) revert InvalidParameters();
        // Masters must be locked (never set up / initialized themselves).
        if (BondingCurveV3(curveMaster_).initializer() != address(1)
            || address(LaunchTokenV3(tokenMaster_).rewardAsset()) != address(1)) revert InvalidParameters();
        factory = factory_;
        curveMaster = curveMaster_;
        tokenMaster = tokenMaster_;
    }

    function deploy(bytes32 curveSalt, bytes32 tokenSalt, string calldata name, string calldata symbol,
        BondingCurveV2.Settings calldata settings, address[] calldata exclusions, address reserveRecipient, uint256 reserveAmount,
        address[] calldata protectionExempt) external returns (LaunchToken token, BondingCurveV2 curve)
    {
        if (msg.sender != factory || settings.factory != factory) revert Unauthorized();
        address c = Clones.cloneDeterministic(curveMaster, _curveSalt(curveSalt, settings));
        BondingCurveV3(c).setup(abi.decode(abi.encode(settings), (BondingCurveV3.Settings)));
        address t = Clones.cloneDeterministic(tokenMaster, tokenSalt);
        LaunchTokenV3(t).initialize(name, symbol, c, settings.supply, settings.quote, exclusions, reserveRecipient, reserveAmount);
        BondingCurveV3(c).initialize(LaunchToken(t), protectionExempt);
        return (LaunchToken(t), BondingCurveV2(c));
    }

    /// @return curve The curve address; @return initHash The token clone's init-code hash to search salts against.
    function tokenInitHash(bytes32 curveSalt, string calldata, string calldata, BondingCurveV2.Settings calldata settings,
        address[] calldata, address, uint256) public view returns (address curve, bytes32 initHash)
    {
        curve = Clones.predictDeterministicAddress(curveMaster, _curveSalt(curveSalt, settings));
        // Same 55 bytes Clones.cloneDeterministic deploys.
        initHash = keccak256(abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", tokenMaster,
            hex"5af43d82803e903d91602b57fd5bf3"));
    }

    function predict(bytes32 curveSalt, bytes32 tokenSalt, string calldata name, string calldata symbol,
        BondingCurveV2.Settings calldata settings, address[] calldata exclusions)
        external view returns (address token, address curve)
    {
        (curve,) = tokenInitHash(curveSalt, name, symbol, settings, exclusions, address(0), 0);
        token = Clones.predictDeterministicAddress(tokenMaster, tokenSalt);
    }

    function _curveSalt(bytes32 curveSalt, BondingCurveV2.Settings calldata settings) private pure returns (bytes32) {
        return keccak256(abi.encode(curveSalt, keccak256(abi.encode(settings))));
    }
}
