import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, keccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { CREATE2_PROXY, attach, deploySystem, validateConfig } from '../scripts/deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

// Runtime code of the deterministic deployment proxy, installed locally because
// the in-process chain starts empty. Real chains must already have it.
const PROXY_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const E18 = 10n ** 18n;

test('deployment script wires a working system and refuses wrong chains or bad configs', async () => {
  const connection = await network.create('local');
  try {
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 20;
    const [deployer, governor, platform, trader] = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
    await connection.provider.request({ method: 'hardhat_setCode', params: [CREATE2_PROXY, PROXY_RUNTIME] });
    const pmArtifact = output.v4core['@uniswap/v4-core/src/PoolManager.sol'].PoolManager;
    const poolManager = await new ContractFactory(pmArtifact.abi, pmArtifact.evm.bytecode.object, deployer).deploy(deployer);
    const wethArtifact = output.contracts['test/Fixtures.sol'].MockWETH;
    const weth = await new ContractFactory(wethArtifact.abi, wethArtifact.evm.bytecode.object, deployer).deploy();
    const config = {
      chainId: 31337, poolManager: await poolManager.getAddress(),
      poolManagerCodeHash: keccak256(await provider.getCode(poolManager)), weth: await weth.getAddress(),
      governor: await governor.getAddress(), platformRecipient: await platform.getAddress(),
      launchConfig: { supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '1400000000000000000' },
    };
    assert.throws(() => validateConfig({ ...config, weth: null }));
    assert.throws(() => validateConfig({ ...config, launchConfig: { ...config.launchConfig, reservedTokens: config.launchConfig.supply } }));
    await assert.rejects(deploySystem({ signer: deployer, artifacts: output.contracts, config: { ...config, chainId: 4663 } }), /chain/);
    await assert.rejects(deploySystem({ signer: deployer, artifacts: output.contracts,
      config: { ...config, poolManagerCodeHash: '0x' + '00'.repeat(32) } }), /code hash/);

    const result = await deploySystem({ signer: deployer, artifacts: output.contracts, config });
    const c = result.contracts;
    const factory = attach(output.contracts, 'contracts/LaunchFactory.sol', 'LaunchFactory', c.LaunchFactory, governor);
    assert.equal(await factory.pendingOwner(), await governor.getAddress());
    await (await factory.acceptOwnership()).wait();
    assert.equal(await factory.owner(), await governor.getAddress());
    assert.equal(await factory.router(), c.LaunchRouter);
    assert.equal(await factory.platformRecipient(), await platform.getAddress());

    // End-to-end on the deployed system: launch, graduate, trade on the pool.
    const router = attach(output.contracts, 'contracts/LaunchRouter.sol', 'LaunchRouter', c.LaunchRouter, trader);
    const params = { name: 'Deployed', symbol: 'DPL', metadataURI: 'ipfs://x', creatorRecipient: await trader.getAddress(),
      creatorBps: 100, holderShareBps: 5000, buybackShareBps: 0, salt: '0x' + '22'.repeat(32),
      expectedEconomics: await factory.previewEconomics(0, weth), tokenSalt: '0x' + '00'.repeat(32), launchProtection: true, protectionExempt: [] };
    const [dep, , initHash] = await factory.tokenInitHash(await trader.getAddress(), params, 0, weth);
    params.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
    const token = await factory.predictToken(await trader.getAddress(), params, 0, weth);
    await (await router.launch(params, 0, weth, 0, 0, 2n ** 64n)).wait();
    await (await router.buy(token, 10n * E18, 0, await trader.getAddress(), 2n ** 64n, { value: 10n * E18 })).wait();
    const routing = await factory.launchRouting(token);
    const locker = attach(output.contracts, 'contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', c.LiquidityLocker, trader);
    assert.equal(await locker.isLocked(routing.poolId), true);
    const escrow = attach(output.contracts, 'contracts/FeeEscrow.sol', 'FeeEscrow', c.FeeEscrow, trader);
    const before = await escrow.balances(weth, await platform.getAddress());
    await (await router.buy(token, E18, 1, await trader.getAddress(), 2n ** 64n, { value: E18 })).wait();
    assert.equal(await escrow.balances(weth, await platform.getAddress()) - before, E18 * 20n / 10_000n);
  } finally { await connection.close(); }
});
