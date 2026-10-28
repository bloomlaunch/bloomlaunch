// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {LaunchFactory} from "../LaunchFactory.sol";
import {Migration} from "./Migration.sol";

/// @notice Creates migrations with fixed terms. Creation is reviewed by the
/// governor (migrations move community funds); once created, the governor has no
/// power over a migration's deposits, terms or outcome.
contract MigrationFactory is Ownable2Step {
    LaunchFactory public immutable launchFactory;
    IPoolManager public immutable poolManager;
    address[] public migrations;
    mapping(address => bool) public isMigration;
    event MigrationCreated(address indexed migration, address indexed oldToken, address indexed quote, string symbol);

    constructor(address governor, LaunchFactory launchFactory_, IPoolManager poolManager_) Ownable(governor) {
        launchFactory = launchFactory_;
        poolManager = poolManager_;
    }

    function create(address oldToken, address quote, PoolKey calldata oldPool, Migration.Epoch[] calldata epochs,
        Migration.SaleRules calldata rules, Migration.Replacement calldata replacement)
        external onlyOwner returns (address migration)
    {
        migration = address(new Migration(launchFactory, poolManager, oldToken, quote, oldPool, epochs, rules, replacement));
        migrations.push(migration);
        isMigration[migration] = true;
        emit MigrationCreated(migration, oldToken, quote, replacement.symbol);
    }

    function migrationCount() external view returns (uint256) { return migrations.length; }
}
