import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, MaxUint256, keccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { CREATE2_PROXY, attach, deploySystem } from '../scripts/deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

// External-token migration against the real V4 PoolManager: the old token trades
// in an ordinary V4 pool (0.30% fee, no hooks) that BloomLaunch does not control.
const PROXY_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const tx = async p => (await p).wait();

async function setup() {
  const connection = await network.create('local');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  const w = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(i => provider.getSigner(i)));
  const a = await Promise.all(w.map(x => x.getAddress()));
  const deployArt = async (art, args = [], signer = w[0]) => {
    const c = await new ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const fixture = (name, args) => deployArt(output.contracts['test/Fixtures.sol'][name], args);
  await connection.provider.request({ method: 'hardhat_setCode', params: [CREATE2_PROXY, PROXY_RUNTIME] });
  const poolManager = await deployArt(output.v4core['@uniswap/v4-core/src/PoolManager.sol'].PoolManager, [a[0]]);
  const weth = await fixture('MockWETH');
  const config = { chainId: 31337, poolManager: await poolManager.getAddress(), poolManagerCodeHash: keccak256(await provider.getCode(poolManager)),
    weth: await weth.getAddress(), governor: a[0], platformRecipient: a[6],
    launchConfig: { supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '1400000000000000000' } };
  const sys = (await deploySystem({ signer: w[0], artifacts: output.contracts, config })).contracts;
  const at = (file, name, address) => attach(output.contracts, file, name, address, w[0]);
  const migrationFactory = at('contracts/migration/MigrationFactory.sol', 'MigrationFactory', sys.MigrationFactory);
  const launchFactory = at('contracts/LaunchFactory.sol', 'LaunchFactory', sys.LaunchFactory);

  // Old token and its external V4 market: price 0.0001 WETH per old token, deep liquidity.
  const old = await fixture('MockBlockable');
  const oldIs0 = BigInt(await old.getAddress()) < BigInt(await weth.getAddress());
  const key = { currency0: oldIs0 ? await old.getAddress() : await weth.getAddress(),
    currency1: oldIs0 ? await weth.getAddress() : await old.getAddress(), fee: 3000, tickSpacing: 60, hooks: '0x' + '00'.repeat(20) };
  await tx(poolManager.initialize(key, oldIs0 ? Q96 / 100n : Q96 * 100n));
  const lp = await deployArt(output.v4core['@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol'].PoolModifyLiquidityTest, [await poolManager.getAddress()]);
  await tx(weth.deposit({ value: 200n * E18 }));
  await tx(weth.approve(lp, MaxUint256));
  await tx(old.approve(lp, MaxUint256));
  await tx(lp.modifyLiquidity(key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 22n, salt: '0x' + '00'.repeat(32) }, '0x'));
  for (const i of [1, 2, 3, 5]) await tx(old.transfer(a[i], 10n ** 24n));

  const now = async () => BigInt((await provider.getBlock('latest')).timestamp);
  const advance = async seconds => {
    await connection.provider.request({ method: 'evm_increaseTime', params: [Number(seconds)] });
    await connection.provider.request({ method: 'evm_mine', params: [] });
  };
  const spot = async () => {
    const view = new Contract(await poolManager.getAddress(), ['function extsload(bytes32) view returns (bytes32)'], w[0]);
    const poolId = keccak256(new (await import('ethers')).AbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
    const slot = keccak256(new (await import('ethers')).AbiCoder().encode(['bytes32', 'uint256'], [poolId, 6n]));
    const sqrt = BigInt(await view.extsload(slot)) & ((1n << 160n) - 1n);
    // Quote (WETH) per old token, scaled by 1e18.
    return oldIs0 ? sqrt * sqrt * E18 / (Q96 * Q96) : Q96 * Q96 * E18 / (sqrt * sqrt);
  };
  async function create(overrides = {}) {
    const t = await now();
    const epochs = overrides.epochs ?? [{ end: t + 1000n, rate: 12n * E18 / 10n, cap: 3n * 10n ** 22n }, { end: t + 2000n, rate: E18, cap: 10n ** 24n }];
    const rules = { minDeposits: 10n ** 22n, minProceeds: E18 / 10n, floorPriceX18: 5n * 10n ** 13n, maxImpactBps: 300,
      maxTrancheBps: 2500, cooldown: 60, saleDeadline: t + 5000n, settleDeadline: t + 8000n, vestingDuration: 3 * 86400, ...overrides.rules };
    const replacement = { name: 'Reborn', symbol: 'REBORN', metadataURI: '', creatorRecipient: a[4], creatorBps: 100,
      holderShareBps: 5000, buybackShareBps: 0, configId: 0 };
    const receipt = await tx(migrationFactory.create(old, weth, key, epochs, rules, replacement));
    const event = receipt.logs.map(l => { try { return migrationFactory.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'MigrationCreated');
    const m = at('contracts/migration/Migration.sol', 'Migration', event.args.migration);
    for (const i of [1, 2, 3, 5]) await tx(old.connect(w[i]).approve(m, MaxUint256));
    return m;
  }
  return { connection, provider, w, a, weth, old, key, oldIs0, poolManager, migrationFactory, launchFactory, sys, at, now, advance, spot, create };
}

test('migration success: epochs and caps, bounded sales, replacement launch, vesting claims, rewards and closure', async () => {
  const s = await setup();
  try {
    const m = await s.create();
    const [w, a] = [s.w, s.a];
    // Epoch 0 pays 1.2 credits per token up to its cap; a full epoch closes early.
    await tx(m.connect(w[1]).deposit(2n * 10n ** 22n));
    await assert.rejects(m.connect(w[2]).deposit(2n * 10n ** 22n), 'over the epoch cap');
    await tx(m.connect(w[2]).deposit(10n ** 22n));
    assert.deepEqual([...(await m.currentEpoch())], [1n, true], 'full epoch 0 closed early');
    await tx(m.connect(w[2]).deposit(10n ** 22n));
    await tx(m.connect(w[3]).deposit(10n ** 22n));
    await tx(m.connect(w[3]).withdraw(1, 5n * 10n ** 21n));
    assert.equal(await m.creditsOf(a[1]), 24n * 10n ** 21n);
    assert.equal(await m.creditsOf(a[2]), 22n * 10n ** 21n);
    assert.equal(await m.creditsOf(a[3]), 5n * 10n ** 21n);
    await assert.rejects(m.closeDeposits(), 'deposits still open');
    await assert.rejects(m.sellTranche(10n ** 21n, 0), 'no sales during deposits');
    await s.advance(2001);
    await assert.rejects(m.connect(w[3]).withdraw(1, 1n), 'no withdrawals after the deposit period');
    await tx(m.closeDeposits());
    assert.equal(await m.phase(), 1n, 'Selling');

    // Bounded tranches: size cap, cooldown, impact limit as a swap price limit.
    const total = await m.totalDeposited();
    await assert.rejects(m.sellTranche(total, 0), 'over the tranche cap');
    let sales = 0;
    while (await m.sold() < total) {
      const before = await s.spot();
      await tx(m.connect(w[6]).sellTranche(await m.maxTranche(), 0));
      const after = await s.spot();
      assert.ok(after * 10_000n >= before * 9_700n - before, `tranche ${sales} moved the price at most ~3%`);
      if (sales === 0) await assert.rejects(m.sellTranche(1n, 0), 'cooldown');
      sales++;
      await s.advance(61);
    }
    assert.ok(sales >= 4);
    const proceeds = await m.proceeds();
    assert.equal(await s.weth.balanceOf(m), proceeds);

    // Settlement launches a normal BloomLaunch token with the branded suffix and buys it.
    assert.equal(await m.canSettle(), true);
    const params = (await m.launchParams('0x' + '00'.repeat(32))).toObject();
    const [dep, , initHash] = await s.launchFactory.tokenInitHash(await m.getAddress(), params, 0, s.weth);
    const { salt } = await mineTokenSalt(dep, initHash);
    await tx(m.connect(w[6]).settle(salt));
    assert.equal(await m.phase(), 2n, 'Settled');
    const token = s.at('contracts/LaunchToken.sol', 'LaunchToken', await m.replacementToken());
    assert.ok((await token.getAddress()).toLowerCase().endsWith('b00b'));
    const total2 = await m.replacementTotal();
    assert.equal(await token.balanceOf(m), total2);
    assert.equal((await s.launchFactory.launches(token)).creator, await m.getAddress());

    // Linear vesting over three days, pro rata to credits.
    await s.advance(86400 * 3 / 2);
    const half = await m.claimable(a[1]);
    const share1 = total2 * 24n / 51n;
    assert.ok(half > share1 * 49n / 100n && half < share1 * 51n / 100n, 'about half vested');
    await tx(m.connect(w[1]).claim());
    await s.advance(86400 * 2);
    await tx(m.connect(w[1]).claim());
    assert.ok(share1 - (await token.balanceOf(a[1])) <= 1n, 'full share after vesting');
    await tx(m.connect(w[2]).claim());

    // Holder rewards earned while tokens waited in the migration are shared by credits.
    const rewards = await m.rewardsClaimable(a[2]);
    assert.ok(rewards > 0n, 'rewards accrued on tokens held by the migration');
    {
      const before = await s.weth.balanceOf(a[2]);
      await tx(m.connect(w[2]).claimRewards());
      assert.equal(await s.weth.balanceOf(a[2]) - before, rewards);
    }
    // Leftover quote from a capped final curve buy is returned pro rata to deposits.
    assert.ok(await m.leftoverQuote() > 0n, 'the curve graduated and capped the purchase');
    assert.equal(await s.at('contracts/BondingCurve.sol', 'BondingCurve', (await s.launchFactory.launches(token)).curve).phase(), 3n,
      'replacement graduated to its locked V4 pool');
    {
      const share = await m.quoteShare(a[1]);
      await tx(m.connect(w[1]).withdrawQuote());
      await assert.rejects(m.connect(w[1]).withdrawQuote(), 'one withdrawal per leg');
      assert.ok(share > 0n);
    }

    // After 90 days unclaimed replacement tokens are burned and claims end.
    await assert.rejects(m.closeClaims(), 'window still open');
    await s.advance(90 * 86400);
    await assert.rejects(m.connect(w[3]).claim(), 'claim window over');
    await tx(m.closeClaims());
    assert.equal(await token.balanceOf(m), 0n);
    assert.ok(await token.balanceOf('0x000000000000000000000000000000000000dEaD') > 0n);
    await assert.rejects(m.closeClaims());
  } finally { await s.connection.close(); }
});

test('migration failure: too few deposits refunds every old token', async () => {
  const s = await setup();
  try {
    const m = await s.create({ rules: { minDeposits: 10n ** 23n } });
    const before = await s.old.balanceOf(s.a[1]);
    await tx(m.connect(s.w[1]).deposit(10n ** 22n));
    await s.advance(2001);
    await tx(m.closeDeposits());
    assert.equal(await m.phase(), 3n, 'Failed');
    await assert.rejects(m.connect(s.w[1]).withdrawQuote(), 'no proceeds to return');
    await tx(m.connect(s.w[1]).withdrawUnsold());
    assert.equal(await s.old.balanceOf(s.a[1]), before);
  } finally { await s.connection.close(); }
});

test('migration failure on low proceeds: anyone fails it, and a blocked old-token leg cannot block the quote leg', async () => {
  const s = await setup();
  try {
    const m = await s.create({ rules: { minProceeds: 10n * E18 } });
    await tx(m.connect(s.w[1]).deposit(10n ** 22n));
    await tx(m.connect(s.w[2]).deposit(10n ** 22n));
    await s.advance(2001);
    await tx(m.closeDeposits());
    await tx(m.sellTranche(await m.maxTranche(), 0));
    const proceeds = await m.proceeds();
    assert.ok(proceeds > 0n && proceeds < 10n * E18);
    await assert.rejects(m.fail(), 'sales still open and settlement still possible');
    await s.advance(5000);
    await assert.rejects(m.sellTranche(1n, 0), 'sales closed');
    assert.equal(await m.canSettle(), false, 'below minimum proceeds');
    await tx(m.connect(s.w[5]).fail());
    assert.equal(await m.phase(), 3n, 'Failed');
    // Depositor 1's old-token transfers now revert; their quote refund still works.
    await tx(s.old.setBlocked(s.a[1], true));
    await assert.rejects(m.connect(s.w[1]).withdrawUnsold());
    const q = await m.quoteShare(s.a[1]);
    assert.equal(q, proceeds / 2n);
    const before = await s.weth.balanceOf(s.a[1]);
    await tx(m.connect(s.w[1]).withdrawQuote());
    assert.equal(await s.weth.balanceOf(s.a[1]) - before, q);
    await tx(s.old.setBlocked(s.a[1], false));
    const unsold = await m.unsoldShare(s.a[1]);
    assert.equal(unsold, (2n * 10n ** 22n - await m.sold()) / 2n);
    await tx(m.connect(s.w[1]).withdrawUnsold());
    await tx(m.connect(s.w[2]).withdrawUnsold());
    assert.ok(await s.old.balanceOf(m) <= 1n, 'all unsold old tokens returned');
  } finally { await s.connection.close(); }
});

test('migration price floor rejects sales below the published minimum price', async () => {
  const s = await setup();
  try {
    // Floor above the current market price (0.0001): no tranche can ever clear it.
    const m = await s.create({ rules: { floorPriceX18: 2n * 10n ** 14n } });
    await tx(m.connect(s.w[1]).deposit(2n * 10n ** 22n));
    await s.advance(2001);
    await tx(m.closeDeposits());
    await assert.rejects(m.sellTranche(await m.maxTranche(), 0), /PriceFloor|reverted/);
    assert.equal(await m.sold(), 0n);
  } finally { await s.connection.close(); }
});

test('migration factory: only the governor creates, and terms must be coherent', async () => {
  const s = await setup();
  try {
    const t = await s.now();
    const epochs = [{ end: t + 1000n, rate: E18, cap: E18 }];
    const rules = { minDeposits: 1n, minProceeds: 0n, floorPriceX18: 0n, maxImpactBps: 300, maxTrancheBps: 2500, cooldown: 60,
      saleDeadline: t + 2000n, settleDeadline: t + 3000n, vestingDuration: 0 };
    const rep = { name: 'R', symbol: 'R', metadataURI: '', creatorRecipient: s.a[4], creatorBps: 0, holderShareBps: 0, buybackShareBps: 0, configId: 0 };
    await assert.rejects(s.migrationFactory.connect(s.w[1]).create(s.old, s.weth, s.key, epochs, rules, rep), 'governor only');
    const usdc = await new ContractFactory(output.contracts['test/Fixtures.sol'].MockUSDC.abi, output.contracts['test/Fixtures.sol'].MockUSDC.evm.bytecode.object, s.w[0]).deploy();
    await assert.rejects(s.migrationFactory.create(usdc, s.weth, s.key, epochs, rules, rep), 'pool must contain the old token');
    await assert.rejects(s.migrationFactory.create(s.old, s.weth, s.key, epochs, { ...rules, saleDeadline: t + 10n }, rep), 'sale after deposits');
    await assert.rejects(s.migrationFactory.create(s.old, s.weth, s.key, epochs, { ...rules, maxImpactBps: 5000 }, rep), 'impact bound');
    await assert.rejects(s.migrationFactory.create(s.old, s.weth, s.key, [], rules, rep), 'needs epochs');
    await tx(s.migrationFactory.create(s.old, s.weth, s.key, epochs, rules, rep));
    assert.equal(await s.migrationFactory.migrationCount(), 1n);
  } finally { await s.connection.close(); }
});
