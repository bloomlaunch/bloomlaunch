import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, ZeroHash, keccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { CREATE2_PROXY, attach, deploySystemV2, launchBloom, upgradeToCloneLaunches } from '../scripts/deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const PROXY_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const E18 = 10n ** 18n;
const tx = async p => (await p).wait();

// The live situation: a system deployed with the v2 (full-contract) deployer and BLOOM already launched,
// then upgraded in place to clone launches. Old coins keep working; new coins are clones.
test('clone launches: in-place factory upgrade, old coins untouched, new coins are locked EIP-1167 clones', async () => {
  const connection = await network.create('local');
  try {
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 20;
    const w = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(i => provider.getSigner(i)));
    const a = await Promise.all(w.map(x => x.getAddress()));
    const rpc = (method, params = []) => connection.provider.request({ method, params });
    const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp) + 600n;
    await rpc('hardhat_setCode', [CREATE2_PROXY, PROXY_RUNTIME]);
    const art = (file, name) => output.contracts[file]?.[name] ?? output.v4core[file][name];
    const deployArt = async (file, name, args = []) => {
      const c = await new ContractFactory(art(file, name).abi, art(file, name).evm.bytecode.object, w[0]).deploy(...args);
      await c.waitForDeployment(); return c;
    };
    const pm = await deployArt('@uniswap/v4-core/src/PoolManager.sol', 'PoolManager', [a[0]]);
    const weth = await deployArt('test/Fixtures.sol', 'MockWETH');
    const config = { chainId: 31337, poolManager: await pm.getAddress(), poolManagerCodeHash: keccak256(await provider.getCode(pm)),
      weth: await weth.getAddress(), governor: a[0], platformRecipient: a[6], bloomBurnBps: 5000,
      launchConfig: { supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '1400000000000000000' } };
    const MIN_BUY = 14n * 10n ** 13n;
    const sys = await deploySystemV2({ signer: w[0], artifacts: output.contracts, config, minInitialBuy: MIN_BUY, cloneLaunches: false });
    const c = sys.contracts;
    const { bloom } = await launchBloom({ signer: w[0], artifacts: output.contracts, contracts: c, weth: config.weth, team: a[3], mineTokenSalt, v2: true });
    const at = (file, name, address, signer = w[0]) => attach(output.contracts, file, name, address, signer);
    const factory = at('contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', c.LaunchFactory);
    const router = at('contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', c.LaunchRouter);
    const params = (name, salt, creator) => ({ name, symbol: name.slice(0, 4).toUpperCase(), metadataURI: '', creatorRecipient: creator,
      creatorBps: 100, holderShareBps: 5000, buybackShareBps: 0, salt, expectedEconomics: ZeroHash, tokenSalt: ZeroHash,
      launchProtection: true, protectionExempt: [] });
    const launch = async (p, creator, signer) => {
      p.expectedEconomics = await factory.previewEconomics(0, config.weth);
      const [dep, , initHash] = await factory.tokenInitHash(creator, p, 0, config.weth);
      p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
      const predicted = await factory.predictToken(creator, p, 0, config.weth);
      const rc = await tx(router.connect(signer).launch(p, 0, config.weth, MIN_BUY, 0, await deadline(), { value: MIN_BUY }));
      assert.ok((await factory.launches(predicted)).curve !== '0x0000000000000000000000000000000000000000', 'predicted token address was launched');
      return { token: predicted, gas: rc.gasUsed };
    };

    // Before: a full-contract launch.
    const old = await launch(params('Old Coin', '0x' + '01'.repeat(32), a[1]), a[1], w[1]);

    // Strangers cannot upgrade; the owner can; a second run is a no-op.
    await assert.rejects(upgradeToCloneLaunches({ signer: w[5], artifacts: output.contracts, contracts: c }), /only the factory owner/);
    const up = await upgradeToCloneLaunches({ signer: w[0], artifacts: output.contracts, contracts: c });
    assert.equal(await factory.deployer(), up.LaunchDeployer);
    assert.equal((await upgradeToCloneLaunches({ signer: w[0], artifacts: output.contracts, contracts: c })).LaunchDeployer, up.LaunchDeployer);
    await assert.rejects(factory.initializeV2(up.LaunchDeployer), 'initializeV2 runs once');
    // Factory state survived the upgrade.
    assert.equal(await factory.platformToken(), bloom);
    assert.equal(await factory.minInitialBuy(), MIN_BUY);
    assert.equal(await factory.router(), c.LaunchRouter);
    assert.equal((await factory.launches(old.token)).creator, a[1]);

    // After: a clone launch, with the same client flow (tokenInitHash + salt search) and a b00b address.
    const fresh = await launch(params('New Coin', '0x' + '02'.repeat(32), a[2]), a[2], w[2]);
    assert.ok(fresh.token.toLowerCase().endsWith('b00b'));
    console.log(`launch gas: full contracts ${old.gas}, clones ${fresh.gas} (${(Number(old.gas) / Number(fresh.gas)).toFixed(1)}x less)`);
    assert.ok(fresh.gas * 2n < old.gas, 'clone launch costs well under half');

    // Both clones are EIP-1167 proxies of the fixed masters (plus their 32-byte parameter commitment).
    const curveAddr = (await factory.launches(fresh.token)).curve;
    const dep = at('contracts/v3/LaunchDeployerV3.sol', 'LaunchDeployerV3', up.LaunchDeployer);
    const minimal = master => '0x363d3d373d3d3d363d73' + master.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
    for (const [address, master] of [[fresh.token, await dep.tokenMaster()], [curveAddr, await dep.curveMaster()]]) {
      const code = await provider.getCode(address);
      assert.equal(code.length, 2 + (45 + 32) * 2);
      assert.ok(code.startsWith(minimal(master)), 'EIP-1167 clone of the master');
    }
    // Masters can never be set up or initialized, and clones only once.
    const curveMaster = at('contracts/v3/BondingCurveV3.sol', 'BondingCurveV3', await dep.curveMaster());
    const tokenMaster = at('contracts/v3/LaunchTokenV3.sol', 'LaunchTokenV3', await dep.tokenMaster());
    const curve = at('contracts/v3/BondingCurveV3.sol', 'BondingCurveV3', curveAddr);
    const token = at('contracts/v3/LaunchTokenV3.sol', 'LaunchTokenV3', fresh.token);
    const settings = await curve.settings();
    await assert.rejects(curveMaster.setup(settings), 'curve master locked');
    await assert.rejects(curve.setup(settings), 'curve set up once');
    await assert.rejects(curve.initialize(fresh.token, []), 'curve initialized once');
    await assert.rejects(tokenMaster.initialize('X', 'X', a[0], 1n, config.weth, [], a[0], 0n), 'token master locked');
    await assert.rejects(token.initialize('X', 'X', a[0], 1n, config.weth, [], a[0], 0n), 'token initialized once');
    // Only the factory can use the deployer.
    await assert.rejects(dep.connect(w[5]).deploy(ZeroHash, ZeroHash, 'X', 'X', settings, [], a[0], 0n, []));

    // The clone behaves like a v2 token and curve.
    assert.equal(await token.name(), 'New Coin');
    assert.equal(await token.symbol(), 'NEW ');
    assert.equal(await token.totalSupply(), 10n ** 27n);
    assert.equal(await token.rewardAsset(), config.weth);
    assert.equal(await token.excluded(curveAddr), true);
    assert.equal(await token.excluded(up.LaunchDeployer), true, 'the new deployer is reward-excluded');
    assert.equal(await curve.initializer(), up.LaunchDeployer);
    assert.equal(await curve.factory(), c.LaunchFactory);
    assert.ok(await curve.phantomTokens() > 0n);
    assert.ok(await curve.protectionActive(), 'snipe protection on');
    assert.ok(await token.balanceOf(a[2]) > 0n, 'creator got the first buy');

    // Trade both coins, then graduate the clone into its locked V4 pool and keep trading there.
    const buyer = w[4], b = a[4];
    await rpc('evm_increaseTime', [301]); await rpc('evm_mine');
    for (const t of [old.token, fresh.token]) {
      await tx(router.connect(buyer).buy(t, E18 / 10n, 1, b, await deadline(), { value: E18 / 10n }));
      const tc = at('contracts/LaunchToken.sol', 'LaunchToken', t, buyer);
      const held = await tc.balanceOf(b);
      await tx(tc.approve(c.LaunchRouter, held));
      await tx(router.connect(buyer).sell(t, held / 2n, 1, b, await deadline(), true));
    }
    const [, gross] = await curve.quoteBuy(10n ** 40n);
    await tx(router.connect(buyer).buy(fresh.token, gross + E18, 1, b, await deadline(), { value: gross + E18, gasLimit: 12_000_000n }));
    assert.equal(Number(await curve.phase()), 3, 'clone graduated');
    const poolId = (await factory.launches(fresh.token)).poolId;
    assert.notEqual(poolId, ZeroHash);
    const locker = at('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', c.LiquidityLocker);
    assert.ok(await locker.isLocked(poolId), 'graduated liquidity locked');
    const before = await token.balanceOf(b);
    await tx(router.connect(buyer).buy(fresh.token, E18 / 100n, 1, b, await deadline(), { value: E18 / 100n }));
    assert.ok(await token.balanceOf(b) > before, 'trades on the V4 pool after graduation');
    // Holder rewards accrue on the clone token.
    assert.ok(await token.totalFunded() > 0n, 'holder rewards funded');
  } finally {
    await connection.close();
  }
});
