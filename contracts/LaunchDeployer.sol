// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BondingCurve} from "./BondingCurve.sol";
import {LaunchToken} from "./LaunchToken.sol";

/// @notice The curve uses a creator-scoped salt; the token uses its own salt so a
/// client can cheaply search for a token address with the required suffix. The
/// token's init code already contains the creator-scoped curve address, so the
/// token salt cannot be front-run into a different launch.
contract LaunchDeployer {
    address public immutable factory;
    error Unauthorized();
    constructor(address factory_) { factory = factory_; }
    function deploy(bytes32 curveSalt, bytes32 tokenSalt, string calldata name, string calldata symbol,
        BondingCurve.Settings calldata settings, address[] calldata exclusions, address reserveRecipient, uint256 reserveAmount,
        address[] calldata protectionExempt) external returns (LaunchToken token, BondingCurve curve)
    {
        if (msg.sender != factory || settings.factory != factory) revert Unauthorized();
        curve = new BondingCurve{salt: curveSalt}(settings);
        token = new LaunchToken{salt: tokenSalt}(name, symbol, address(curve), settings.supply, settings.quote, exclusions,
            reserveRecipient, reserveAmount);
        curve.initialize(token, protectionExempt);
    }

    /// @return curve The curve address; @return tokenInitHash The token init-code hash to search salts against.
    function tokenInitHash(bytes32 curveSalt, string calldata name, string calldata symbol,
        BondingCurve.Settings calldata settings, address[] calldata exclusions, address reserveRecipient, uint256 reserveAmount)
        public view returns (address curve, bytes32 initHash)
    {
        curve = _create2(curveSalt, keccak256(abi.encodePacked(type(BondingCurve).creationCode, abi.encode(settings))));
        initHash = keccak256(abi.encodePacked(type(LaunchToken).creationCode,
            abi.encode(name, symbol, curve, settings.supply, settings.quote, exclusions, reserveRecipient, reserveAmount)));
    }

    function predict(bytes32 curveSalt, bytes32 tokenSalt, string calldata name, string calldata symbol,
        BondingCurve.Settings calldata settings, address[] calldata exclusions)
        external view returns (address token, address curve)
    {
        bytes32 initHash;
        (curve, initHash) = tokenInitHash(curveSalt, name, symbol, settings, exclusions, address(0), 0);
        token = _create2(tokenSalt, initHash);
    }

    function _create2(bytes32 salt, bytes32 initHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }
}
