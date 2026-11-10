// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {BondingCurveV2} from "../v2/BondingCurveV2.sol";
import {LaunchToken} from "../LaunchToken.sol";
import {BondingCurveV3} from "./BondingCurveV3.sol";
import {LaunchTokenV3} from "./LaunchTokenV3.sol";

/// @notice v3 deployer: the same interface as LaunchDeployerV2, so the factory, router, site, agents
/// and indexers need no changes, but each launch is two EIP-1167 clones of fixed master copies
/// (created once, by this constructor) instead of two full contract deployments.
///
/// Each clone carries a 32-byte immutable argument: the hash of its launch parameters. A clone's
/// CREATE2 address therefore commits to those parameters exactly as a v2 init-code hash did: the
/// curve address to its creator-scoped salt and settings, the token address to its name, symbol,
/// curve, supply, reward asset, exclusions and reserve. A client still searches `tokenSalt` against
/// `tokenInitHash` for the b00b suffix, and a mined salt cannot be reused for a different launch.
///
/// The masters have no owner and no upgrade path, and clones delegate to them by fixed address, so a
/// launched token and curve can never change.
contract LaunchDeployerV3 {
    address public immutable factory;
    address public immutable curveMaster;
    address public immutable tokenMaster;
    error Unauthorized();

    constructor(address factory_) {
        factory = factory_;
        curveMaster = address(new BondingCurveV3());
        tokenMaster = address(new LaunchTokenV3());
    }

    function deploy(bytes32 curveSalt, bytes32 tokenSalt, string calldata name, string calldata symbol,
        BondingCurveV2.Settings calldata settings, address[] calldata exclusions, address reserveRecipient, uint256 reserveAmount,
        address[] calldata protectionExempt) external returns (LaunchToken token, BondingCurveV2 curve)
    {
        if (msg.sender != factory || settings.factory != factory) revert Unauthorized();
        address c = Clones.cloneDeterministicWithImmutableArgs(curveMaster, _curveArgs(settings), curveSalt);
        BondingCurveV3(c).setup(abi.decode(abi.encode(settings), (BondingCurveV3.Settings)));
        address t = Clones.cloneDeterministicWithImmutableArgs(tokenMaster,
            _tokenArgs(name, symbol, c, settings, exclusions, reserveRecipient, reserveAmount), tokenSalt);
        LaunchTokenV3(t).initialize(name, symbol, c, settings.supply, settings.quote, exclusions, reserveRecipient, reserveAmount);
        BondingCurveV3(c).initialize(LaunchToken(t), protectionExempt);
        return (LaunchToken(t), BondingCurveV2(c));
    }

    /// @return curve The curve address; @return initHash The token clone's init-code hash to search salts against.
    function tokenInitHash(bytes32 curveSalt, string calldata name, string calldata symbol,
        BondingCurveV2.Settings calldata settings, address[] calldata exclusions, address reserveRecipient, uint256 reserveAmount)
        public view returns (address curve, bytes32 initHash)
    {
        curve = Clones.predictDeterministicAddressWithImmutableArgs(curveMaster, _curveArgs(settings), curveSalt);
        initHash = keccak256(_cloneCode(tokenMaster,
            _tokenArgs(name, symbol, curve, settings, exclusions, reserveRecipient, reserveAmount)));
    }

    function predict(bytes32 curveSalt, bytes32 tokenSalt, string calldata name, string calldata symbol,
        BondingCurveV2.Settings calldata settings, address[] calldata exclusions)
        external view returns (address token, address curve)
    {
        bytes32 initHash;
        (curve, initHash) = tokenInitHash(curveSalt, name, symbol, settings, exclusions, address(0), 0);
        token = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), tokenSalt, initHash)))));
    }

    function _curveArgs(BondingCurveV2.Settings calldata settings) private pure returns (bytes memory) {
        return abi.encode(keccak256(abi.encode(settings)));
    }

    function _tokenArgs(string calldata name, string calldata symbol, address curve, BondingCurveV2.Settings calldata settings,
        address[] calldata exclusions, address reserveRecipient, uint256 reserveAmount) private pure returns (bytes memory)
    {
        return abi.encode(keccak256(abi.encode(name, symbol, curve, settings.supply, settings.quote, exclusions,
            reserveRecipient, reserveAmount)));
    }

    /// @dev Same bytes as OpenZeppelin Clones' private `_cloneCodeWithImmutableArgs` (EIP-1167 plus appended args).
    function _cloneCode(address implementation, bytes memory args) private pure returns (bytes memory) {
        return abi.encodePacked(hex"61", uint16(args.length + 0x2d), hex"3d81600a3d39f3363d3d373d3d3d363d73",
            implementation, hex"5af43d82803e903d91602b57fd5bf3", args);
    }
}
