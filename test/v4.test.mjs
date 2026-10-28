import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { AbiCoder, BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress,
  concat, getCreate2Address, keccak256, solidityPackedKeccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

// Integration tests against the real Uniswap V4 PoolManager compiled from
// @uniswap/v4-core 1.0.2. No mock executor, mock pool or mock lock is used here.
const coder = AbiCoder.defaultAbiCoder();
const HOOK_FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n);
const ALL_HOOK_MASK = (1n << 14n) - 1n;
const E18 = 10n ** 18n;
const DEADLINE = 2n ** 64n;
const artifact = (file, name) => output.contracts[file]?.[name] ?? output.v4core[file][name];
const tx = async promise => (await promise).wait();
const fees = (gross, creatorBps) => {
  const platform = gross * 20n / 10_000n, creator = gross * BigInt(creatorBps) / 10_000n;
  return { platform, creator, net: gross - platform - creator };
};
const allocate = (creatorFee, holderBps, buybackBps) => {
  const holders = creatorFee * BigInt(holderBps) / 10_000n, buyback = creatorFee * BigInt(buybackBps) / 10_000n;
  return { holders, buyback, earnings: creatorFee - holders - buyback };
};

async function setup() {
  const connection = await network.create('local');
  const chain = { request: args => connection.provider.request(args), disconnect: () => connection.close() };
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  const wallets = await Promise.all(Array.from({ length: 7 }, (_, i) => provider.getSigner(i)));
  const addresses = await Promise.all(wallets.map(w => w.getAddress()));
  async function deploy(file, name, args = []) {
    const { abi, evm } = artifact(file, name);
    const contract = await new ContractFactory(abi, evm.bytecode.object, wallets[0]).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }
  const at = (file, name, address) => new Contract(address, artifact(file, name).abi, wallets[0]);
  const advance = async seconds => {
    await chain.request({ method: 'evm_increaseTime', params: [Number(seconds)] });
    await chain.request({ method: 'evm_mine', params: [] });
  };
  return { chain, provider, wallets, addresses, deploy, at, advance };
}

function events(contract, receipt, name) {
  return receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
    .filter(event => event?.name === name);
}

/// Deploys the complete production contract set against a real PoolManager.
async function system(s) {
  const [gov, , , platform] = s.addresses;
  const poolManager = await s.deploy('@uniswap/v4-core/src/PoolManager.sol', 'PoolManager', [gov]);
  const weth = await s.deploy('test/Fixtures.sol', 'MockWETH');
  const escrow = await s.deploy('contracts/FeeEscrow.sol', 'FeeEscrow');
  const adapter = await s.deploy('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', [poolManager, gov]);
  const vault = await s.deploy('contracts/BuybackVestingVault.sol', 'BuybackVestingVault', [gov, adapter]);
  const locker = await s.deploy('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', [poolManager, gov]);
  const factory = await s.deploy('contracts/LaunchFactory.sol', 'LaunchFactory',
    [gov, platform, escrow, vault, poolManager, locker]);
  // Mine a CREATE2 salt so the hook address carries exactly its permission bits.
  const create2 = await s.deploy('test/Fixtures.sol', 'Create2Deployer');
  const hookArtifact = artifact('contracts/v4/BloomFeeHook.sol', 'BloomFeeHook');
  const initCode = concat([hookArtifact.evm.bytecode.object.startsWith('0x') ? hookArtifact.evm.bytecode.object
    : '0x' + hookArtifact.evm.bytecode.object, coder.encode(['address', 'address'], [await poolManager.getAddress(), await factory.getAddress()])]);
  const initHash = keccak256(initCode);
  let salt, hookAddress;
  for (let i = 0n; ; i++) {
    salt = '0x' + i.toString(16).padStart(64, '0');
    hookAddress = getCreate2Address(await create2.getAddress(), salt, initHash);
    if ((BigInt(hookAddress) & ALL_HOOK_MASK) === HOOK_FLAGS) break;
  }
  await tx(create2.deploy(salt, initCode));
  const hook = s.at('contracts/v4/BloomFeeHook.sol', 'BloomFeeHook', hookAddress);
  await tx(locker.bind(factory, hook));
  await tx(vault.bindFactory(factory));
  await tx(adapter.bindVault(vault));
  const router = await s.deploy('contracts/LaunchRouter.sol', 'LaunchRouter', [factory, poolManager, weth]);
  await tx(factory.bindRouter(router));
  await tx(factory.configureQuote(weth, true));
  await tx(factory.addConfig({ supply: 10n**27n, reservedTokens: 2n*10n**26n, phantomQuote: 14n*10n**17n,
    quote: await weth.getAddress(), executor: await locker.getAddress(), enabled: true }));
  return { poolManager, weth, escrow, adapter, vault, locker, factory, hook, router, create2 };
}

/// Launches through the router, choosing a salt that yields the requested
/// token/quote ordering, so both V4 currency orders are exercised.
async function launch(s, sys, { tokenFirst, creatorBps = 500, holderShareBps = 4000, buybackShareBps = 2000, firstBuy = 0n }) {
  const creator = s.wallets[1];
  const base = { name: 'Bloom Test', symbol: 'BLOOM', metadataURI: 'ipfs://bloom', creatorRecipient: s.addresses[1],
    creatorBps, holderShareBps, buybackShareBps, expectedEconomics: await sys.factory.previewEconomics(0, sys.weth),
    salt: '0x' + '01'.repeat(32), tokenSalt: '0x' + '00'.repeat(32), launchProtection: false, protectionExempt: [] };
  const quote = BigInt(await sys.weth.getAddress());
  const [deployerAddress, , initHash] = await sys.factory.tokenInitHash(s.addresses[1], base, 0, sys.weth);
  let params;
  for (;;) {
    params = { ...base, tokenSalt: (await mineTokenSalt(deployerAddress, initHash)).salt };
    const predicted = BigInt(await sys.factory.predictToken(s.addresses[1], params, 0, sys.weth));
    if ((predicted < quote) === tokenFirst) break;
  }
  const receipt = await tx(sys.router.connect(creator).launch(params, 0, sys.weth, firstBuy, 0, DEADLINE, { value: firstBuy }));
  const launched = events(sys.factory, receipt, 'TokenLaunched')[0];
  assert.equal(launched.args.creator, s.addresses[1], 'router launches are attributed to the caller');
  const token = s.at('contracts/LaunchToken.sol', 'LaunchToken', launched.args.token);
  const curve = s.at('contracts/BondingCurve.sol', 'BondingCurve', launched.args.curve);
  assert.equal(BigInt(launched.args.token) < quote, tokenFirst);
  return { token, curve, params, receipt };
}

async function graduate(s, sys, l) {
  const trader = s.wallets[2];
  // A completing buy with too little gas reverts instead of skipping graduation.
  await assert.rejects(sys.router.connect(trader).buy(l.token, 10n * E18, 0, s.addresses[2], DEADLINE,
    { value: 10n * E18, gasLimit: 2_000_000 }));
  assert.equal(await l.curve.phase(), 1n, 'still CurveActive after the rejected attempt');
  const before = await s.provider.getBalance(s.addresses[2]);
  const receipt = await tx(sys.router.connect(trader).buy(l.token, 10n * E18, 0, s.addresses[2], DEADLINE, { value: 10n * E18 }));
  const spent = before - await s.provider.getBalance(s.addresses[2]) - receipt.gasUsed * receipt.gasPrice;
  assert.ok(spent < 10n * E18, 'unused ETH is refunded by the final curve buy');
  assert.equal(await l.curve.phase(), 3n, 'PoolActive');
  return receipt;
}

for (const tokenFirst of [true, false]) {
  test(`v4 graduation creates a locked canonical pool at the curve price (token is currency${tokenFirst ? 0 : 1})`, async () => {
    const s = await setup();
    try {
      const sys = await system(s);
      const l = await launch(s, sys, { tokenFirst, firstBuy: E18 / 10n });
      assert.ok(await l.token.balanceOf(s.addresses[1]) > 0n, 'first buy in the launch transaction');
      const receipt = await graduate(s, sys, l);
      assert.ok(receipt.gasUsed < 3_000_000n, `graduating buy used ${receipt.gasUsed} gas`);
      const [locked] = events(sys.locker, receipt, 'LiquidityLocked');
      const { poolId, liquidity, sqrtPriceX96, tokenAmount, quoteAmount } = locked.args;
      const routing = await sys.factory.launchRouting(l.token);
      assert.equal(routing.poolId, poolId);
      assert.equal(await sys.locker.isLocked(poolId), true);
      // Real V4 state: the position belongs to the locker and holds the liquidity.
      const positionKey = solidityPackedKeccak256(['address', 'int24', 'int24', 'bytes32'],
        [await sys.locker.getAddress(), -887200, 887200, '0x' + '00'.repeat(32)]);
      const pmView = new Contract(await sys.poolManager.getAddress(),
        ['function extsload(bytes32) view returns (bytes32)'], s.wallets[0]);
      const poolsSlot = keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6n]));
      const positionsMapping = '0x' + (BigInt(poolsSlot) + 6n).toString(16).padStart(64, '0');
      const positionSlot = keccak256(coder.encode(['bytes32', 'bytes32'], [positionKey, positionsMapping]));
      assert.equal(BigInt(await pmView.extsload(positionSlot)) & ((1n << 128n) - 1n), liquidity);
      const slot0 = BigInt(await pmView.extsload(poolsSlot));
      assert.equal(slot0 & ((1n << 160n) - 1n), sqrtPriceX96);
      // Opening pool price equals the curve's terminal marginal price (rounding only).
      const phantomTokens = (2n*10n**26n) ** 2n / (10n**27n - 4n*10n**26n);
      const curveQ = 14n*10n**17n + quoteAmount, curveT = 2n*10n**26n + phantomTokens;
      const diff = quoteAmount * curveT > curveQ * tokenAmount ? quoteAmount * curveT - curveQ * tokenAmount
        : curveQ * tokenAmount - quoteAmount * curveT;
      assert.ok(diff * 10_000n <= curveQ * tokenAmount, 'terminal curve and pool prices agree within 0.01%');
      const [a0, a1] = tokenFirst ? [tokenAmount, quoteAmount] : [quoteAmount, tokenAmount];
      const implied = (sqrtPriceX96 * sqrtPriceX96 * 10n**18n) >> 192n;
      assert.ok(implied * a0 / 10n**18n <= a1 && a1 - implied * a0 / 10n**18n <= a1 / 10n**12n);
      // All released assets are inside the PoolManager; locker and router hold nothing.
      for (const holder of [sys.locker, sys.router, sys.hook]) {
        assert.equal(await l.token.balanceOf(holder), 0n);
        assert.equal(await sys.weth.balanceOf(holder), 0n);
      }
      // No withdrawal path exists on the locker.
      const lockerFunctions = sys.locker.interface.fragments.filter(f => f.type === 'function').map(f => f.name).sort();
      assert.deepEqual(lockerFunctions, ['POSITION_SALT', 'TICK_LOWER', 'TICK_SPACING', 'TICK_UPPER', 'bind', 'bootstrapper',
        'execute', 'factory', 'feeHook', 'isLocked', 'liquidityFor', 'locks', 'poolManager', 'sqrtPriceFor', 'unlockCallback']);
      await assert.rejects(sys.locker.unlockCallback('0x'), 'only the PoolManager can enter the callback');
      await assert.rejects(sys.locker.execute(l.token, sys.weth, 1, 1), 'only the factory can execute');
      await assert.rejects(sys.locker.bind(sys.factory, sys.hook), 'binding is one-time');
      // Nobody else can create a pool with the canonical hook.
      const key = await sys.hook.poolKey(l.token);
      await assert.rejects(sys.poolManager.initialize({ ...key.toObject(), tickSpacing: 60 }, 2n ** 96n));
      await assert.rejects(sys.factory.tryGraduate(l.token), 'graduation cannot repeat');
      await assert.rejects(l.curve.buy(1, 0, s.addresses[2], DEADLINE), 'curve trading closes after graduation');
    } finally { await s.chain.disconnect(); }
  });

  test(`v4 hook charges exactly 0.20% platform plus the creator rate on every trade type (token is currency${tokenFirst ? 0 : 1})`, async () => {
    const s = await setup();
    try {
      const sys = await system(s);
      const creatorBps = 500, holderShareBps = 4000, buybackShareBps = 2000;
      const l = await launch(s, sys, { tokenFirst, creatorBps, holderShareBps, buybackShareBps });
      await graduate(s, sys, l);
      const trader = s.wallets[4];
      await tx(sys.weth.connect(trader).deposit({ value: 50n * E18 }));
      await tx(sys.weth.connect(trader).approve(sys.router, MaxUint256));
      await tx(l.token.connect(trader).approve(sys.router, MaxUint256));
      const snapshot = async () => ({
        platform: await sys.escrow.balances(sys.weth, s.addresses[3]),
        creator: await sys.escrow.balances(sys.weth, s.addresses[1]),
        holders: await l.token.totalFunded(),
        buyback: await sys.vault.pending(l.token, s.addresses[1]),
        pmQuote: await sys.weth.balanceOf(sys.poolManager),
      });
      const check = async (before, gross, label) => {
        const after = await snapshot();
        const f = fees(gross, creatorBps), a = allocate(f.creator, holderShareBps, buybackShareBps);
        assert.equal(after.platform - before.platform, f.platform, `${label}: platform fee`);
        assert.equal(after.holders - before.holders, a.holders, `${label}: holder rewards`);
        assert.equal(after.buyback - before.buyback, a.buyback, `${label}: buyback funding`);
        assert.equal(after.creator - before.creator, a.earnings, `${label}: creator earnings`);
      };
      const parse = receipt => events(sys.hook, receipt, 'PoolFees')[0].args;

      // Exact-input buy: fee base is the gross quote paid.
      let before = await snapshot();
      let receipt = await tx(sys.router.connect(trader).buy(l.token, E18, 1, s.addresses[4], DEADLINE));
      await check(before, E18, 'exact-input buy');
      assert.equal(parse(receipt).platformFee, E18 * 20n / 10_000n);
      assert.equal(before.pmQuote + fees(E18, creatorBps).net, await sys.weth.balanceOf(sys.poolManager),
        'only the post-fee net enters the pool');

      // Exact-input sell: fee base is the gross quote output.
      const tokens = await l.token.balanceOf(s.addresses[4]);
      before = await snapshot();
      const quoteBefore = await sys.weth.balanceOf(s.addresses[4]);
      receipt = await tx(sys.router.connect(trader).sell(l.token, tokens / 2n, 1, s.addresses[4], DEADLINE, false));
      const received = await sys.weth.balanceOf(s.addresses[4]) - quoteBefore;
      const grossOut = before.pmQuote - await sys.weth.balanceOf(sys.poolManager);
      assert.equal(received, fees(grossOut, creatorBps).net);
      await check(before, grossOut, 'exact-input sell');

      // Exact-output buy: trader pays the pool input plus fees on its gross.
      before = await snapshot();
      const paidBefore = await sys.weth.balanceOf(s.addresses[4]);
      const tokenBefore = await l.token.balanceOf(s.addresses[4]);
      receipt = await tx(sys.router.connect(trader).buyExactOut(l.token, 10n**24n, 5n * E18, s.addresses[4], DEADLINE));
      assert.equal(await l.token.balanceOf(s.addresses[4]) - tokenBefore, 10n**24n);
      const paid = paidBefore - await sys.weth.balanceOf(s.addresses[4]);
      const poolIn = await sys.weth.balanceOf(sys.poolManager) - before.pmQuote;
      const { platformFee, creatorFee } = parse(receipt);
      assert.equal(paid, poolIn + platformFee + creatorFee);
      assert.ok(fees(paid, creatorBps).net >= poolIn && fees(paid - 1n, creatorBps).net < poolIn + 1n);

      // Exact-output sell: trader receives exactly the requested net quote.
      before = await snapshot();
      const wantBefore = await sys.weth.balanceOf(s.addresses[4]);
      receipt = await tx(sys.router.connect(trader).sellExactOut(l.token, E18 / 10n, await l.token.balanceOf(s.addresses[4]), s.addresses[4], DEADLINE, false));
      assert.equal(await sys.weth.balanceOf(s.addresses[4]) - wantBefore, E18 / 10n);
      const gross = before.pmQuote - await sys.weth.balanceOf(sys.poolManager);
      assert.equal(parse(receipt).platformFee + parse(receipt).creatorFee, gross - E18 / 10n);

      // Native ETH in and out of the graduated pool.
      const ethBefore = await s.provider.getBalance(s.addresses[5]);
      await tx(sys.router.connect(s.wallets[5]).buy(l.token, E18, 1, s.addresses[5], DEADLINE, { value: E18 }));
      const bought = await l.token.balanceOf(s.addresses[5]);
      await tx(l.token.connect(s.wallets[5]).approve(sys.router, MaxUint256));
      await tx(sys.router.connect(s.wallets[5]).sell(l.token, bought, 1, s.addresses[5], DEADLINE, true));
      assert.ok(await s.provider.getBalance(s.addresses[5]) < ethBefore);
      assert.equal(await sys.weth.balanceOf(sys.router), 0n);

      // Slippage and deadline protection.
      await assert.rejects(sys.router.connect(trader).buy(l.token, E18, 10n**30n, s.addresses[4], DEADLINE));
      await assert.rejects(sys.router.connect(trader).buy(l.token, E18, 1, s.addresses[4], 1));
      await assert.rejects(sys.router.connect(trader).buyExactOut(l.token, 10n**24n, 1n, s.addresses[4], DEADLINE));

      // Holder rewards from pool trades are claimable in the quote asset.
      const claimable = await l.token.claimable(s.addresses[4]);
      assert.ok(claimable > 0n);
      const pre = await sys.weth.balanceOf(s.addresses[4]);
      await tx(l.token.connect(trader).claimRewards(s.addresses[4]));
      assert.equal(await sys.weth.balanceOf(s.addresses[4]) - pre, claimable);
      // The hook keeps no balance between transactions.
      assert.equal(await sys.weth.balanceOf(sys.hook), 0n);
    } finally { await s.chain.disconnect(); }
  });
}

test('v4 post-graduation creator takeover and buyback toggles follow the curve rules', async () => {
  const s = await setup();
  try {
    const sys = await system(s);
    const l = await launch(s, sys, { tokenFirst: true, creatorBps: 1000, holderShareBps: 0, buybackShareBps: 5000 });
    await graduate(s, sys, l);
    const trader = s.wallets[4];
    const buy = () => tx(sys.router.connect(trader).buy(l.token, E18, 1, s.addresses[4], DEADLINE, { value: E18 }));
    const curvePending = await sys.vault.pending(l.token, s.addresses[1]);
    await buy();
    const oldPending = await sys.vault.pending(l.token, s.addresses[1]);
    assert.equal(oldPending - curvePending, E18 / 10n / 2n, 'pool trades fund buybacks like curve trades');
    await tx(sys.factory.connect(s.wallets[1]).setBuybacks(l.token, false));
    let before = await sys.escrow.balances(sys.weth, s.addresses[1]);
    await buy();
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[1]) - before, E18 / 10n, 'disabled buyback share goes to creator');
    assert.equal(await sys.vault.pending(l.token, s.addresses[1]), oldPending);
    await tx(sys.factory.connect(s.wallets[1]).setBuybacks(l.token, true));
    await tx(sys.factory.proposeTakeover(l.token, s.addresses[6]));
    await s.advance(3 * 86400 + 1);
    await tx(sys.factory.connect(s.wallets[5]).executeTakeover(l.token));
    before = await sys.escrow.balances(sys.weth, s.addresses[6]);
    await buy();
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[6]) - before, E18 / 20n, 'new recipient earns future fees');
    assert.equal(await sys.vault.pending(l.token, s.addresses[6]), E18 / 20n);
    assert.equal(await sys.vault.pending(l.token, s.addresses[1]), oldPending, 'old funding is preserved');
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[3]) > 0n, true);
  } finally { await s.chain.disconnect(); }
});

test('v4 canonical buyback uses the TWAP, refuses displaced prices and never funds itself', async () => {
  const s = await setup();
  try {
    const sys = await system(s);
    const l = await launch(s, sys, { tokenFirst: false, creatorBps: 1000, holderShareBps: 2000, buybackShareBps: 5000 });
    await graduate(s, sys, l);
    const trader = s.wallets[4];
    const buy = amount => tx(sys.router.connect(trader).buy(l.token, amount, 1, s.addresses[4], DEADLINE, { value: amount }));
    await buy(E18);
    const pending = await sys.vault.pending(l.token, s.addresses[1]);
    const deadline = async () => BigInt((await s.provider.getBlock('latest')).timestamp) + 240n;
    // No 30-minute observation yet.
    assert.deepEqual([...(await sys.adapter.limits(l.token, sys.weth, pending))], [0n, 0n]);
    await assert.rejects(sys.vault.execute(l.token, s.addresses[1], pending, await deadline()));
    for (let i = 0; i < 4; i++) { await s.advance(600); await buy(E18 / 100n); }
    const [minTokens, maxInput] = await sys.adapter.limits(l.token, sys.weth, pending);
    assert.ok(minTokens > 0n && maxInput > 0n);
    // A large displacement of spot price blocks execution until the mean catches up.
    await buy(3n * E18);
    assert.deepEqual([...(await sys.adapter.limits(l.token, sys.weth, pending))], [0n, 0n]);
    await assert.rejects(sys.vault.execute(l.token, s.addresses[1], pending, await deadline()));
    await s.advance(2 * 3600);
    for (let i = 0; i < 3; i++) { await s.advance(700); await buy(E18 / 1000n); }
    const funded = await sys.vault.pending(l.token, s.addresses[1]);
    const platformBefore = await sys.escrow.balances(sys.weth, s.addresses[3]);
    const cap = (await sys.adapter.limits(l.token, sys.weth, pending))[1];
    assert.ok(cap > 0n && cap < pending, 'trade size is capped by pool liquidity');
    await assert.rejects(sys.vault.execute(l.token, s.addresses[1], pending, await deadline()), 'oversized buyback');
    const amount = cap / 2n;
    const receipt = await tx(sys.vault.execute(l.token, s.addresses[1], amount, await deadline()));
    const [executed] = events(sys.vault, receipt, 'BuybackExecuted');
    assert.ok(executed.args.tokensBought > 0n);
    assert.equal(await sys.vault.pending(l.token, s.addresses[1]), funded - amount, 'the buyback trade funds no further buyback');
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[3]) - platformBefore, amount * 20n / 10_000n,
      'platform still earns exactly 0.20% on the buyback trade');
    assert.equal(await sys.vault.lotCount(l.token, s.addresses[1]), 1n);
    await assert.rejects(sys.adapter.swap(l.token, sys.weth, 1, 0, s.addresses[0], DEADLINE), 'only the vault can swap');
  } finally { await s.chain.disconnect(); }
});

test('v4 router and factory reject unauthorized launches and the locker rejects unrepresentable prices', async () => {
  const s = await setup();
  try {
    const sys = await system(s);
    const params = { name: 'X', symbol: 'X', metadataURI: '', creatorRecipient: s.addresses[1], creatorBps: 0,
      holderShareBps: 0, buybackShareBps: 0, salt: '0x' + '11'.repeat(32), expectedEconomics: await sys.factory.previewEconomics(0, sys.weth),
      tokenSalt: '0x' + '00'.repeat(32), launchProtection: false, protectionExempt: [] };
    await assert.rejects(sys.factory.launchFor(s.addresses[1], params, 0, sys.weth), 'only the bound router');
    await assert.rejects(sys.factory.bindRouter(sys.router), 'router binding is one-time');
    await assert.rejects(sys.router.launch(params, 0, sys.weth, 0, 0, DEADLINE, { value: 1 }), 'stray ETH is rejected');
    await assert.rejects(sys.locker.sqrtPriceFor(1, 2n ** 70n));
    await assert.rejects(sys.locker.sqrtPriceFor(0, 1));
    assert.equal(await sys.locker.sqrtPriceFor(E18, E18), 2n ** 96n);
    // A creator-fee-free launch still pays exactly the platform fee in the pool.
    const free = await launch(s, sys, { tokenFirst: true, creatorBps: 0, holderShareBps: 0, buybackShareBps: 0 });
    await graduate(s, sys, free);
    const before = await sys.escrow.balances(sys.weth, s.addresses[3]);
    await tx(sys.router.connect(s.wallets[4]).buy(free.token, E18, 1, s.addresses[4], DEADLINE, { value: E18 }));
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[3]) - before, E18 * 20n / 10_000n);
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[1]), 0n);
  } finally { await s.chain.disconnect(); }
});

test('v4 full lifecycle with a 6-decimal stablecoin quote: curve, graduation, locked pool and exact fees', async () => {
  const s = await setup();
  try {
    const sys = await system(s);
    const usdc = await s.deploy('test/Fixtures.sol', 'MockUSDC');
    const U = 10n ** 6n;
    await tx(sys.factory.configureQuote(usdc, true));
    await tx(sys.factory.addConfig({ supply: 10n**27n, reservedTokens: 2n*10n**26n, phantomQuote: 5_000n * U,
      quote: await usdc.getAddress(), executor: await sys.locker.getAddress(), enabled: true }));
    const id = 1;
    const params = { name: 'Stable Bloom', symbol: 'SBLM', metadataURI: '', creatorRecipient: s.addresses[1], creatorBps: 100,
      holderShareBps: 5000, buybackShareBps: 0, salt: '0x' + '33'.repeat(32), expectedEconomics: await sys.factory.previewEconomics(id, usdc),
      tokenSalt: '0x' + '00'.repeat(32), launchProtection: false, protectionExempt: [] };
    await assert.rejects(sys.router.connect(s.wallets[1]).launch(params, 0, usdc, 0, 0, DEADLINE), 'WETH config cannot be used with USDC');
    const [dep, , initHash] = await sys.factory.tokenInitHash(s.addresses[1], params, id, usdc);
    params.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
    const receipt = await tx(sys.router.connect(s.wallets[1]).launch(params, id, usdc, 0, 0, DEADLINE));
    const token = s.at('contracts/LaunchToken.sol', 'LaunchToken', events(sys.factory, receipt, 'TokenLaunched')[0].args.token);
    assert.ok((await token.getAddress()).toLowerCase().endsWith('b00b'));
    const trader = s.wallets[2];
    await tx(usdc.transfer(s.addresses[2], 100_000n * U));
    await tx(usdc.connect(trader).approve(sys.router, MaxUint256));
    await tx(token.connect(trader).approve(sys.router, MaxUint256));
    // ETH cannot pay for a USDC launch.
    await assert.rejects(sys.router.connect(trader).buy(token, U, 0, s.addresses[2], DEADLINE, { value: U }));
    const before = await usdc.balanceOf(s.addresses[2]);
    const grad = await tx(sys.router.connect(trader).buy(token, 50_000n * U, 0, s.addresses[2], DEADLINE));
    const spent = before - await usdc.balanceOf(s.addresses[2]);
    assert.ok(spent > 10_000n * U && spent < 20_000n * U, `graduation needed ${spent / U} USDC, rest refunded`);
    const [locked] = events(sys.locker, grad, 'LiquidityLocked');
    assert.equal(await sys.locker.isLocked(locked.args.poolId), true);
    const platformBefore = await sys.escrow.balances(usdc, s.addresses[3]);
    await tx(sys.router.connect(trader).buy(token, 1_000n * U, 1, s.addresses[2], DEADLINE));
    assert.equal(await sys.escrow.balances(usdc, s.addresses[3]) - platformBefore, 2n * U, 'exactly 0.20% of 1,000 USDC');
    const sellBefore = await usdc.balanceOf(s.addresses[2]);
    await tx(sys.router.connect(trader).sell(token, 10n**24n, 1, s.addresses[2], DEADLINE, false));
    assert.ok(await usdc.balanceOf(s.addresses[2]) > sellBefore);
    assert.ok(await token.claimable(s.addresses[2]) > 0n, 'holder rewards accrue in USDC');
  } finally { await s.chain.disconnect(); }
});

test('v4 limit orders: signed off-chain, filled by anyone at or better than the limit, cancellable', async () => {
  const s = await setup();
  try {
    const sys = await system(s);
    const executor = await s.deploy('contracts/LimitOrderExecutor.sol', 'LimitOrderExecutor', [sys.router]);
    const l = await launch(s, sys, { tokenFirst: true });
    await graduate(s, sys, l);
    const maker = s.wallets[4], keeper = s.wallets[5];
    const makerAddr = s.addresses[4];
    await tx(sys.weth.connect(maker).deposit({ value: 5n * E18 }));
    await tx(sys.weth.connect(maker).approve(executor, MaxUint256));
    await tx(l.token.connect(maker).approve(executor, MaxUint256));
    const { chainId } = await s.provider.getNetwork();
    const domain = { name: 'BloomLaunch Limit Orders', version: '1', chainId, verifyingContract: await executor.getAddress() };
    const types = { Order: [{ name: 'maker', type: 'address' }, { name: 'token', type: 'address' }, { name: 'buy', type: 'bool' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] };
    const sign = async order => maker.signTypedData(domain, types, order);
    const quoteNow = await sys.router.connect(maker).buy.staticCall(l.token, E18, 0, makerAddr, DEADLINE, { value: E18 });
    // A buy limit above the market is not fillable yet.
    const tooGreedy = { maker: makerAddr, token: await l.token.getAddress(), buy: true, amountIn: E18, minAmountOut: quoteNow.tokensOut * 2n, expiry: DEADLINE, nonce: 1n };
    await assert.rejects(executor.connect(keeper).fill(tooGreedy, await sign(tooGreedy)));
    // A fillable buy order executes through the router and pays the maker.
    const order = { ...tooGreedy, minAmountOut: quoteNow.tokensOut * 99n / 100n, nonce: 2n };
    const sig = await sign(order);
    const before = await l.token.balanceOf(makerAddr);
    const platformBefore = await sys.escrow.balances(sys.weth, s.addresses[3]);
    await tx(executor.connect(keeper).fill(order, sig));
    assert.ok(await l.token.balanceOf(makerAddr) - before >= order.minAmountOut);
    assert.equal(await sys.escrow.balances(sys.weth, s.addresses[3]) - platformBefore, E18 * 20n / 10_000n, 'normal platform fee');
    await assert.rejects(executor.connect(keeper).fill(order, sig), 'no replay');
    // Tampering with the order invalidates the signature.
    await assert.rejects(executor.connect(keeper).fill({ ...order, nonce: 3n, minAmountOut: 1n }, sig));
    // Sell order, then cancellation and expiry.
    const sell = { maker: makerAddr, token: await l.token.getAddress(), buy: false, amountIn: 10n ** 24n, minAmountOut: 1n, expiry: DEADLINE, nonce: 4n };
    const wethBefore = await sys.weth.balanceOf(makerAddr);
    await tx(executor.connect(keeper).fill(sell, await sign(sell)));
    assert.ok(await sys.weth.balanceOf(makerAddr) > wethBefore);
    const cancelled = { ...sell, nonce: 5n };
    await tx(executor.connect(maker).cancel(5n));
    await assert.rejects(executor.connect(keeper).fill(cancelled, await sign(cancelled)), 'cancelled');
    const expired = { ...sell, nonce: 6n, expiry: 1n };
    await assert.rejects(executor.connect(keeper).fill(expired, await sign(expired)), 'expired');
  } finally { await s.chain.disconnect(); }
});
