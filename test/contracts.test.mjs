import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, MaxUint256, ZeroAddress } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { prepareTransaction } from '../sdk/transactions.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

async function setup() {
  const connection = await network.create('local');
  const chain = { request: args => connection.provider.request(args), disconnect: () => connection.close() };
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  const wallets = await Promise.all(Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
  const addresses = await Promise.all(wallets.map(w => w.getAddress()));
  async function deploy(file, name, args = []) {
    const compiled = output.contracts[file][name];
    const contract = await new ContractFactory(compiled.abi, compiled.evm.bytecode.object, wallets[0]).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  }
  return { chain, wallets, addresses, deploy };
}
const tx = async promise => (await promise).wait();

async function factoryFixture(s, creatorBps = 1000, holderShareBps = 5000, buybackShareBps = 2500, realBuyback = false, launchProtection = false, protectionExempt = []) {
  const quote = await s.deploy('test/Fixtures.sol', 'MockQuote');
  const escrow = await s.deploy('contracts/FeeEscrow.sol', 'FeeEscrow');
  const adapter = realBuyback ? await s.deploy('test/Fixtures.sol', 'MockBuybackAdapter') : null;
  const buyback = realBuyback
    ? await s.deploy('contracts/BuybackVestingVault.sol', 'BuybackVestingVault', [s.addresses[0], await adapter.getAddress()])
    : await s.deploy('test/Fixtures.sol', 'MockBuybackFunding');
  const executor = await s.deploy('test/Fixtures.sol', 'MockGraduationExecutor');
  const factory = await s.deploy('contracts/LaunchFactory.sol', 'LaunchFactory', [s.addresses[0], s.addresses[3],
    await escrow.getAddress(), await buyback.getAddress(), s.addresses[4], s.addresses[5]]);
  if (realBuyback) await tx(buyback.bindFactory(factory));
  await tx(factory.configureQuote(quote, true));
  await tx(factory.addConfig({ supply: 10n**27n, reservedTokens: 2n*10n**26n,
    phantomQuote: 14n*10n**17n, quote: await quote.getAddress(), executor: await executor.getAddress(), enabled: true }));
  const params = { name: 'Launch', symbol: 'LCH', metadataURI: 'ipfs://test-metadata',
    creatorRecipient: s.addresses[1], creatorBps, holderShareBps, buybackShareBps,
    salt: '0x'+'01'.repeat(32), expectedEconomics: await factory.previewEconomics(0, quote),
    tokenSalt: '0x' + '00'.repeat(32), launchProtection, protectionExempt };
  const [deployerAddress, , initHash] = await factory.tokenInitHash(s.addresses[0], params, 0, quote);
  params.tokenSalt = (await mineTokenSalt(deployerAddress, initHash)).salt;
  const receipt = await tx(factory.launch(params, 0, quote));
  const event = receipt.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find(event => event?.name === 'TokenLaunched');
  const token = new Contract(event.args.token, output.contracts['contracts/LaunchToken.sol'].LaunchToken.abi, s.wallets[0]);
  const curve = new Contract(event.args.curve, output.contracts['contracts/BondingCurve.sol'].BondingCurve.abi, s.wallets[0]);
  await tx(quote.transfer(s.addresses[2], 100n*10n**18n));
  await tx(quote.connect(s.wallets[2]).approve(curve, MaxUint256));
  await tx(token.connect(s.wallets[2]).approve(curve, MaxUint256));
  return { quote, escrow, buyback, adapter, executor, factory, params, receipt, token, curve,
    deadline: 2n**128n };
}

async function fundedVault(s) {
  const f = await factoryFixture(s, 1000, 5000, 2500, true);
  await tx(f.curve.connect(s.wallets[2]).buy(10n**17n, 0, s.addresses[2], f.deadline));
  await tx(f.token.connect(s.wallets[2]).transfer(f.adapter, 20n*10n**24n));
  return f;
}
async function shortDeadline(s) {
  const block = await s.chain.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  return BigInt(block.timestamp) + 240n;
}
async function claimWithMargin(vault, signer, args) {
  const request = await prepareTransaction(vault.connect(signer).claimVested, args);
  return tx(signer.sendTransaction(request));
}

test('buyback vault authenticates funding and redirects disabled allocations without changing platform fees', async () => {
  const s = await setup();
  try {
    const f = await fundedVault(s);
    const initial = await f.buyback.pending(f.token, s.addresses[1]);
    assert.equal(initial, 25n*10n**14n);
    assert.equal(await f.buyback.quoteLiabilities(f.quote), initial);
    assert.equal(await f.quote.balanceOf(f.buyback), initial);
    await assert.rejects(f.buyback.deposit(f.token, f.quote, s.addresses[1], 100));
    await assert.rejects(f.buyback.bindFactory(f.factory));
    await assert.rejects(f.buyback.connect(s.wallets[1]).bindFactory(f.factory));
    await assert.rejects(f.factory.setBuybacks(f.token, true));
    await assert.rejects(f.buyback.connect(s.wallets[1]).withdrawPending(f.token, s.addresses[1]));
    await tx(f.factory.connect(s.wallets[1]).setBuybacks(f.token, false));
    const creatorBefore = await f.escrow.balances(f.quote, s.addresses[1]);
    const platformBefore = await f.escrow.balances(f.quote, s.addresses[3]);
    await tx(f.curve.connect(s.wallets[2]).buy(10n**17n, 0, s.addresses[2], f.deadline));
    assert.equal(await f.buyback.pending(f.token, s.addresses[1]), initial);
    assert.equal(await f.escrow.balances(f.quote, s.addresses[1])-creatorBefore, 5n*10n**15n);
    assert.equal(await f.escrow.balances(f.quote, s.addresses[3])-platformBefore, 2n*10n**14n);
    const before = await f.quote.balanceOf(s.addresses[1]);
    await tx(f.buyback.connect(s.wallets[1]).withdrawPending(f.token, s.addresses[1]));
    assert.equal(await f.quote.balanceOf(s.addresses[1])-before, initial);
    assert.equal(await f.buyback.quoteLiabilities(f.quote), 0n);
    await tx(f.factory.connect(s.wallets[1]).setBuybacks(f.token, true));
    assert.equal(await f.factory.buybacksEnabled(f.token), true);
    await tx(f.factory.disableBuybacks(f.token));
    assert.equal(await f.factory.buybacksEnabled(f.token), false);
    assert.equal((await f.curve.settings()).creatorBps, 1000n);
  } finally { await s.chain.disconnect(); }
});

test('buyback vault validates limits, exact spend, approvals, deadlines and failed execution rollback', async () => {
  const s = await setup();
  try {
    const f = await fundedVault(s);
    const amount = await f.buyback.pending(f.token, s.addresses[1]);
    const assertUntouched = async () => {
      assert.equal(await f.buyback.pending(f.token, s.addresses[1]), amount);
      assert.equal(await f.buyback.quoteLiabilities(f.quote), amount);
      assert.equal(await f.quote.balanceOf(f.buyback), amount);
      assert.equal(await f.quote.allowance(f.buyback, f.adapter), 0n);
      assert.equal(await f.buyback.lotCount(f.token, s.addresses[1]), 0n);
    };
    await assert.rejects(f.buyback.execute(f.token, s.addresses[1], amount, 1));
    await assert.rejects(f.buyback.execute(f.token, s.addresses[1], amount, f.deadline));
    await tx(f.adapter.configure(0, 10n**18n, 0));
    await assert.rejects(f.buyback.execute(f.token, s.addresses[1], amount, await shortDeadline(s)));
    await tx(f.adapter.configure(10n**9n, amount-1n, 0));
    await assert.rejects(f.buyback.execute(f.token, s.addresses[1], amount, await shortDeadline(s)));
    for (const mode of [1,2,3,4]) {
      await tx(f.adapter.configure(10n**9n, 10n**18n, mode));
      await assert.rejects(f.buyback.execute(f.token, s.addresses[1], amount, await shortDeadline(s)));
      await assertUntouched();
    }
    await tx(f.adapter.configure(10n**9n, 10n**18n, 0));
    await tx(f.buyback.connect(s.wallets[2]).execute(f.token, s.addresses[1], amount/2n, await shortDeadline(s)));
    assert.equal(await f.buyback.pending(f.token, s.addresses[1]), amount/2n);
    assert.equal(await f.buyback.tokenLiabilities(f.token), amount/2n*10n**9n);
    assert.equal(await f.token.balanceOf(f.buyback), amount/2n*10n**9n);
    assert.equal(await f.quote.allowance(f.buyback, f.adapter), 0n);
    await assert.rejects(f.buyback.execute(f.token, s.addresses[1], amount/2n, await shortDeadline(s)));
  } finally { await s.chain.disconnect(); }
});

test('buyback vesting starts each purchase separately and bounded claims preserve beneficiary rights', async () => {
  const s = await setup();
  try {
    const f = await fundedVault(s);
    const amount = await f.buyback.pending(f.token, s.addresses[1]);
    await tx(f.buyback.execute(f.token, s.addresses[1], amount/2n, await shortDeadline(s)));
    const first = await f.buyback.vestingLot(f.token, s.addresses[1], 0);
    assert.equal(await f.buyback.claimable(f.token, s.addresses[1], 0, 1), 0n);
    await assert.rejects(f.buyback.connect(s.wallets[2]).claimVested(f.token, s.addresses[1], 0, 1, s.addresses[2]));
    await assert.rejects(f.buyback.claimable(f.token, s.addresses[1], 0, 101));
    const duration = Number(await f.buyback.VESTING_DURATION());
    await s.chain.request({ method: 'evm_increaseTime', params: [duration/2] });
    await s.chain.request({ method: 'evm_mine', params: [] });
    await tx(f.buyback.execute(f.token, s.addresses[1], amount/2n, await shortDeadline(s)));
    const second = await f.buyback.vestingLot(f.token, s.addresses[1], 1);
    assert.ok(second.start > first.start);
    assert.equal(await f.buyback.vested(f.token, s.addresses[1], 1), 0n);
    const before = await f.token.balanceOf(s.addresses[1]);
    // A fresh lot can become claimable between estimateGas and mining, adding
    // storage writes. Exercise the same gas-headroom transaction builder as UI.
    await claimWithMargin(f.buyback, s.wallets[2], [f.token, s.addresses[1], 0, 2, s.addresses[1]]);
    const released = (await f.buyback.vestingLot(f.token, s.addresses[1], 0)).released
      +(await f.buyback.vestingLot(f.token, s.addresses[1], 1)).released;
    assert.equal(await f.token.balanceOf(s.addresses[1])-before, released);
    assert.ok(released >= first.amount/2n && released < first.amount*51n/100n);
    await s.chain.request({ method: 'evm_increaseTime', params: [duration/2+1] });
    await s.chain.request({ method: 'evm_mine', params: [] });
    assert.equal(await f.buyback.vested(f.token, s.addresses[1], 0), first.amount);
    assert.ok(await f.buyback.vested(f.token, s.addresses[1], 1) < second.amount);
    await claimWithMargin(f.buyback, s.wallets[1], [f.token, s.addresses[1], 0, 2, s.addresses[1]]);
    await s.chain.request({ method: 'evm_increaseTime', params: [duration/2+1] });
    await s.chain.request({ method: 'evm_mine', params: [] });
    await claimWithMargin(f.buyback, s.wallets[0], [f.token, s.addresses[1], 0, 2, s.addresses[1]]);
    assert.equal(await f.buyback.tokenLiabilities(f.token), 0n);
    assert.equal(await f.token.balanceOf(s.addresses[1])-before, first.amount+second.amount);
    await claimWithMargin(f.buyback, s.wallets[0], [f.token, s.addresses[1], 0, 2, s.addresses[1]]);
    assert.equal(await f.buyback.tokenLiabilities(f.token), 0n);
  } finally { await s.chain.disconnect(); }
});

test('buyback takeover preserves old funding and vesting while future fees follow the new recipient', async () => {
  const s = await setup();
  try {
    const f = await fundedVault(s);
    const amount = await f.buyback.pending(f.token, s.addresses[1]);
    await tx(f.buyback.execute(f.token, s.addresses[1], amount/2n, await shortDeadline(s)));
    await tx(f.factory.connect(s.wallets[1]).transferCreator(f.token, s.addresses[2]));
    await tx(f.curve.connect(s.wallets[2]).buy(10n**17n, 0, s.addresses[2], f.deadline));
    assert.equal(await f.buyback.pending(f.token, s.addresses[2]), amount);
    assert.equal(await f.buyback.pending(f.token, s.addresses[1]), amount/2n);
    await tx(f.buyback.connect(s.wallets[1]).withdrawPending(f.token, s.addresses[1]));
    assert.equal(await f.buyback.pending(f.token, s.addresses[1]), 0n);
    assert.equal(await f.buyback.pending(f.token, s.addresses[2]), amount);
    assert.equal(await f.buyback.lotCount(f.token, s.addresses[1]), 1n);
    assert.equal(await f.buyback.lotCount(f.token, s.addresses[2]), 0n);
    assert.equal(await f.buyback.quoteLiabilities(f.quote), amount);
    assert.equal(await f.quote.balanceOf(f.buyback), amount);
    assert.equal(await f.token.claimable(f.buyback), 0n);
  } finally { await s.chain.disconnect(); }
});

const event = f => f.receipt.logs.map(log => { try { return f.factory.interface.parseLog(log); } catch { return null; } })
  .find(e => e?.name === 'TokenLaunched');

test('opening protection caps each wallet, exempts the creator and can be ended early by the creator only', async () => {
  const s = await setup();
  try {
    const f = await factoryFixture(s, 100, 0, 0, false, true);
    const cap = 10n**27n / 100n;
    assert.equal(await f.curve.protectionActive(), true);
    assert.equal(await f.curve.protectionAllowance(s.addresses[2]), cap);
    // About 0.2 quote units buys more than 1% of supply early on the curve.
    await assert.rejects(f.curve.connect(s.wallets[2]).buy(2n*10n**17n, 0, s.addresses[2], f.deadline), 'over the wallet cap');
    await tx(f.curve.connect(s.wallets[2]).buy(10n**15n, 0, s.addresses[2], f.deadline));
    const bought = await f.token.balanceOf(s.addresses[2]);
    assert.equal(await f.curve.protectionAllowance(s.addresses[2]), cap - bought);
    assert.equal(await f.curve.protectionAllowance(s.addresses[1]), 2n**256n - 1n, 'creator payout wallet is exempt');
    await tx(f.curve.connect(s.wallets[2]).buy(2n*10n**17n, 0, s.addresses[1], f.deadline));
    assert.ok(await f.token.balanceOf(s.addresses[1]) > cap);
    // No extra fee: platform still receives exactly 0.20%.
    const before = await f.escrow.balances(f.quote, s.addresses[3]);
    await tx(f.curve.connect(s.wallets[2]).buy(10n**15n, 0, s.addresses[2], f.deadline));
    assert.equal(await f.escrow.balances(f.quote, s.addresses[3]) - before, 10n**15n * 20n / 10_000n);
    await assert.rejects(f.factory.connect(s.wallets[2]).endProtection(f.token), 'only the creator can end protection');
    await tx(f.factory.connect(s.wallets[1]).endProtection(f.token));
    assert.equal(await f.curve.protectionActive(), false);
    await assert.rejects(f.factory.connect(s.wallets[1]).endProtection(f.token), 'cannot toggle twice');
    await tx(f.curve.connect(s.wallets[2]).buy(2n*10n**17n, 0, s.addresses[2], f.deadline));
    // Without an early end, protection expires on its own after five minutes.
    const g = await factoryFixture(s, 100, 0, 0, false, true);
    await s.chain.request({ method: 'evm_increaseTime', params: [301] });
    await s.chain.request({ method: 'evm_mine', params: [] });
    assert.equal(await g.curve.protectionActive(), false);
    await tx(g.curve.connect(s.wallets[2]).buy(2n*10n**17n, 0, s.addresses[2], g.deadline));
    // Launches without protection are unrestricted from the start.
    const h = await factoryFixture(s, 100, 0, 0, false, false);
    assert.equal(await h.curve.protectionActive(), false);
    // The creator may publicly exempt up to 32 wallets from protection.
    const x = await factoryFixture(s, 100, 0, 0, false, true, [s.addresses[2]]);
    assert.equal(await x.curve.protectionExemptCount(), 1n);
    assert.equal(await x.curve.protectionExempt(s.addresses[2]), true);
    await tx(x.curve.connect(s.wallets[2]).buy(2n*10n**17n, 0, s.addresses[2], x.deadline));
    assert.ok(await x.token.balanceOf(s.addresses[2]) > 10n**27n / 100n, 'exempt wallet bought over the cap');
    await assert.rejects(factoryFixture(s, 100, 0, 0, false, true, Array.from({ length: 33 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'))), 'at most 32');
    await assert.rejects(factoryFixture(s, 100, 0, 0, false, false, [s.addresses[2]]), 'exemptions need protection on');
  } finally { await s.chain.disconnect(); }
});

test('factory launch charges no fee, pins economics and protects constructor limits', async () => {
  const s = await setup();
  try {
    const f = await factoryFixture(s);
    assert.equal(f.receipt.status, 1);
    assert.equal(await f.quote.balanceOf(f.factory), 0n);
    assert.equal(await f.quote.balanceOf(f.curve), 0n);
    assert.equal(await f.token.totalSupply(), 10n**27n);
    assert.equal(await f.token.balanceOf(f.curve), 10n**27n);
    assert.ok(event(f).args.token.toLowerCase().endsWith('b00b'), 'token address carries the BloomLaunch suffix');
    await assert.rejects(f.factory.launch({ ...f.params, salt: '0x' + '02'.repeat(32) }, 0, f.quote), /TokenSuffix|reverted/,
      'an unmined token salt cannot produce a token without the suffix');
    const other = await s.deploy('test/Fixtures.sol', 'MockQuote');
    await tx(f.factory.configureQuote(other, true));
    await assert.rejects(f.factory.launch(f.params, 0, other), 'a configuration is bound to its quote asset');
    await assert.rejects(f.factory.addConfig({ supply: 10n**27n, reservedTokens: 2n*10n**26n, phantomQuote: 1n,
      quote: s.addresses[5], executor: await f.executor.getAddress(), enabled: true }), 'unapproved config quote');
    await assert.rejects(f.factory.launch(f.params, 0, f.quote, { value: 1n }));
    await assert.rejects(f.factory.launch({ ...f.params, creatorBps: 1001 }, 0, f.quote));
    await assert.rejects(f.factory.launch({ ...f.params, holderShareBps: 9000, buybackShareBps: 2000 }, 0, f.quote));
    await assert.rejects(f.factory.launch({ ...f.params, expectedEconomics: '0x'+'00'.repeat(32) }, 0, f.quote));
    await tx(f.factory.setConfigEnabled(0, false));
    await assert.rejects(f.factory.launch(f.params, 0, f.quote));
    for (const [file, name] of [['contracts/LaunchDeployer.sol','LaunchDeployer'],['contracts/LaunchFactory.sol','LaunchFactory']]) {
      assert.ok(output.contracts[file][name].evm.deployedBytecode.object.length / 2 <= 24576, `${name} exceeds EIP-170`);
    }
  } finally { await s.chain.disconnect(); }
});

test('curve buys and sells match quotes, split fees and keep donations out of reserves', async () => {
  const s = await setup();
  try {
    const f = await factoryFixture(s);
    const gross = 10n**17n;
    const q = await f.curve.quoteBuy(gross);
    await tx(f.curve.connect(s.wallets[2]).buy(gross, q.tokensOut, s.addresses[2], f.deadline));
    assert.equal(await f.token.balanceOf(s.addresses[2]), q.tokensOut);
    assert.equal(await f.quote.balanceOf(f.curve), q.net);
    assert.equal(await f.escrow.balances(f.quote, s.addresses[3]), gross*20n/10000n);
    const creatorFee = gross/10n;
    assert.equal(await f.escrow.balances(f.quote, s.addresses[1]), creatorFee/4n);
    assert.equal(await f.buyback.balances(f.token, s.addresses[1]), creatorFee/4n);
    assert.equal(await f.token.totalFunded(), creatorFee/2n);
    const reserve = await f.curve.realQuoteReserve();
    await tx(f.quote.transfer(f.curve, 777));
    assert.equal(await f.curve.realQuoteReserve(), reserve);
    const sold = q.tokensOut/2n;
    const sell = await f.curve.quoteSell(sold);
    const before = await f.quote.balanceOf(s.addresses[2]);
    await tx(f.curve.connect(s.wallets[2]).sell(sold, sell.net, s.addresses[2], f.deadline));
    assert.equal(await f.quote.balanceOf(s.addresses[2])-before, sell.net);
    assert.equal(await f.curve.realQuoteReserve(), reserve-sell.gross);
    assert.equal(await f.quote.balanceOf(f.curve), await f.curve.realQuoteReserve()+777n);
    assert.equal(await f.token.balanceOf(f.curve), await f.curve.tokenReserve()-await f.curve.phantomTokens());
    await assert.rejects(f.curve.connect(s.wallets[2]).buy(gross, MaxUint256, s.addresses[2], f.deadline));
    await assert.rejects(f.curve.connect(s.wallets[2]).buy(gross, 0, s.addresses[2], 1));
    await assert.rejects(f.curve.connect(s.wallets[2]).buy(gross, 0, s.addresses[4], f.deadline));
    await assert.rejects(f.curve.connect(s.wallets[2]).releaseForGraduation(s.addresses[2]));
    const final = await f.curve.quoteBuy(90n*10n**18n);
    const divisor = (await f.curve.settings()).reservedTokens+await f.curve.phantomTokens();
    const numerator = await f.curve.quoteReserve()*await f.curve.remaining();
    const required = (numerator+divisor-1n)/divisor;
    assert.ok(final.net >= required);
    const oneLess = final.grossUsed-1n;
    assert.ok(oneLess-oneLess*20n/10000n-oneLess*1000n/10000n < required,
      'final buy charged more than minimum gross required');
    const platformBefore = await f.escrow.balances(f.quote, s.addresses[3]);
    await tx(f.curve.connect(s.wallets[2]).buy(90n*10n**18n, final.tokensOut, s.addresses[2], f.deadline));
    assert.equal(await f.escrow.balances(f.quote, s.addresses[3])-platformBefore, final.grossUsed*20n/10000n);
    assert.equal(await f.quote.balanceOf(f.curve), await f.curve.realQuoteReserve()+777n);
  } finally { await s.chain.disconnect(); }
});

test('curve graduation caps final input, aligns prices and retries atomically after executor failure', async () => {
  const s = await setup();
  try {
    const f = await factoryFixture(s, 0, 0, 0);
    const max = 100n*10n**18n;
    const q = await f.curve.quoteBuy(max);
    assert.equal(q.tokensOut, 8n*10n**26n);
    assert.ok(q.grossUsed < max);
    const before = await f.quote.balanceOf(s.addresses[2]);
    await tx(f.curve.connect(s.wallets[2]).buy(max, q.tokensOut, s.addresses[2], f.deadline));
    assert.equal(before-await f.quote.balanceOf(s.addresses[2]), q.grossUsed);
    assert.equal(await f.curve.phase(), 2n);
    const virtualQuote = await f.curve.quoteReserve();
    const virtualTokens = await f.curve.tokenReserve();
    const realQuote = await f.curve.realQuoteReserve();
    const realTokens = await f.token.balanceOf(f.curve);
    const difference = virtualQuote*realTokens-realQuote*virtualTokens;
    assert.ok((difference < 0n ? -difference : difference)*10000n <= realQuote*virtualTokens,
      'terminal spot differs by more than one basis point');
    await assert.rejects(f.curve.quoteSell(1));
    await assert.rejects(f.factory.tryGraduate(f.token));
    assert.equal(await f.quote.balanceOf(f.executor), 0n);
    await tx(f.executor.setFail(false));
    await tx(f.executor.setReportLocked(false));
    await assert.rejects(f.factory.tryGraduate(f.token));
    assert.equal(await f.quote.balanceOf(f.curve), realQuote);
    await tx(f.executor.setReportLocked(true));
    await tx(f.factory.tryGraduate(f.token));
    assert.equal(await f.curve.phase(), 3n);
    assert.equal(await f.quote.balanceOf(f.executor), realQuote);
    assert.equal(await f.token.balanceOf(f.executor), realTokens);
    assert.equal(await f.curve.realQuoteReserve(), 0n);
    await assert.rejects(f.factory.tryGraduate(f.token));
  } finally { await s.chain.disconnect(); }
});

test('curve stalled graduation recovers proportionally after delay without additional fees', async () => {
  const s = await setup();
  try {
    const f = await factoryFixture(s, 0, 0, 0);
    const q = await f.curve.quoteBuy(100n*10n**18n);
    await tx(f.curve.connect(s.wallets[2]).buy(100n*10n**18n, q.tokensOut, s.addresses[2], f.deadline));
    await assert.rejects(f.curve.startRecovery());
    await s.chain.request({ method: 'evm_increaseTime', params: [7*86400+1] });
    await s.chain.request({ method: 'evm_mine', params: [] });
    const block = await s.chain.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
    assert.ok(BigInt(block.timestamp) >= await f.curve.pendingSince()+await f.curve.RECOVERY_DELAY());
    assert.equal(await f.curve.phase(), 2n);
    await tx(f.curve.startRecovery());
    const reserve = await f.curve.realQuoteReserve();
    const before = await f.quote.balanceOf(s.addresses[2]);
    await tx(f.curve.connect(s.wallets[2]).refund(q.tokensOut, s.addresses[2]));
    assert.equal(await f.quote.balanceOf(s.addresses[2])-before, reserve);
    assert.equal(await f.curve.refundSupply(), 0n);
    assert.equal(await f.curve.realQuoteReserve(), 0n);
    assert.equal(await f.token.balanceOf(f.curve), 10n**27n);
    await assert.rejects(f.factory.tryGraduate(f.token));
  } finally { await s.chain.disconnect(); }
});

test('takeover changes only future creator rights after public delay', async () => {
  const s = await setup();
  try {
    const f = await factoryFixture(s);
    await tx(f.curve.connect(s.wallets[2]).buy(10n**17n, 0, s.addresses[2], f.deadline));
    const earned = await f.escrow.balances(f.quote, s.addresses[1]);
    await assert.rejects(f.factory.connect(s.wallets[2]).transferCreator(f.token, s.addresses[2]));
    await tx(f.factory.connect(s.wallets[1]).transferCreator(f.token, s.addresses[2]));
    assert.equal(await f.factory.creatorRecipient(f.token), s.addresses[2]);
    assert.equal(await f.escrow.balances(f.quote, s.addresses[1]), earned);
    await tx(f.factory.proposeTakeover(f.token, s.addresses[1]));
    await assert.rejects(f.factory.executeTakeover(f.token));
    await s.chain.request({ method: 'evm_increaseTime', params: [3*86400+1] });
    await s.chain.request({ method: 'evm_mine', params: [] });
    await tx(f.factory.connect(s.wallets[2]).executeTakeover(f.token));
    assert.equal(await f.factory.creatorRecipient(f.token), s.addresses[1]);
    assert.equal(await f.escrow.balances(f.quote, s.addresses[1]), earned);
    assert.equal((await f.curve.settings()).creatorBps, 1000n);
    await assert.rejects(f.factory.executeTakeover(f.token));
  } finally { await s.chain.disconnect(); }
});

test('fee and allocation arithmetic conserves every unit, including maximum uint256', async () => {
  const s = await setup();
  try {
    const harness = await s.deploy('test/Fixtures.sol', 'FeeHarness');
    for (const gross of [0n, 1n, 99n, 10_000n, 10n ** 24n, MaxUint256]) {
      for (const rate of [0n, 1n, 300n, 1000n]) {
        const [platform, creator, net] = await harness.fees(gross, rate);
        assert.equal(platform, gross * 20n / 10_000n);
        assert.equal(creator, gross * rate / 10_000n);
        assert.equal(platform + creator + net, gross);
        const [earnings, holders, buyback] = await harness.allocate(creator, 3333, 6667);
        assert.equal(earnings + holders + buyback, creator);
      }
    }
    await assert.rejects(harness.fees(10000, 1001));
    await assert.rejects(harness.allocate(10000, 7000, 4000));
  } finally { await s.chain.disconnect(); }
});

test('native escrow claims isolate beneficiaries and preserve credit when recipient rejects', async () => {
  const s = await setup();
  try {
    const escrow = await s.deploy('contracts/FeeEscrow.sol', 'FeeEscrow');
    const rejecting = await s.deploy('test/Fixtures.sol', 'RejectNative');
    await tx(escrow.depositNative(s.addresses[1], { value: 1000n }));
    await tx(escrow.depositNative(await rejecting.getAddress(), { value: 700n }));
    await assert.rejects(rejecting.claim(escrow, await rejecting.getAddress()));
    assert.equal(await escrow.balances(ZeroAddress, await rejecting.getAddress()), 700n);
    await tx(escrow.connect(s.wallets[2]).claim(ZeroAddress, s.addresses[2]));
    assert.equal(await escrow.balances(ZeroAddress, s.addresses[1]), 1000n);
    await tx(escrow.connect(s.wallets[1]).claim(ZeroAddress, s.addresses[1]));
    assert.equal(await escrow.liabilities(ZeroAddress), 700n);
    await tx(rejecting.claim(escrow, s.addresses[1]));
    assert.equal(await escrow.liabilities(ZeroAddress), 0n);
  } finally { await s.chain.disconnect(); }
});

test('ERC20 escrow credits actual deposits and rejects taxed assets atomically', async () => {
  const s = await setup();
  try {
    const escrow = await s.deploy('contracts/FeeEscrow.sol', 'FeeEscrow');
    const quote = await s.deploy('test/Fixtures.sol', 'MockQuote');
    const taxed = await s.deploy('test/Fixtures.sol', 'TaxedQuote');
    await tx(quote.approve(escrow, 12345));
    await tx(escrow.depositToken(quote, s.addresses[1], 12345));
    await tx(escrow.connect(s.wallets[1]).claim(quote, s.addresses[2]));
    assert.equal(await quote.balanceOf(s.addresses[2]), 12345n);
    await tx(taxed.approve(escrow, 1000));
    await assert.rejects(escrow.depositToken(taxed, s.addresses[1], 1000));
    assert.equal(await taxed.balanceOf(escrow), 0n);
    assert.equal(await escrow.liabilities(taxed), 0n);
  } finally { await s.chain.disconnect(); }
});

test('holder transfers preserve old earnings and allocate future rewards to new balances', async () => {
  const s = await setup();
  try {
    const quote = await s.deploy('test/Fixtures.sol', 'MockQuote');
    const token = await s.deploy('contracts/LaunchToken.sol', 'LaunchToken', ['Launch', 'LCH', s.addresses[0], 1000, await quote.getAddress(), [s.addresses[5]], ZeroAddress, 0]);
    await tx(quote.approve(token, MaxUint256));
    await tx(token.fundRewards(100));
    assert.equal(await token.pendingRewards(), 100n);
    await tx(token.transfer(s.addresses[1], 100));
    assert.equal(await token.claimable(s.addresses[1]), 100n);
    await tx(token.transfer(s.addresses[2], 100));
    assert.equal(await token.claimable(s.addresses[2]), 0n);
    await tx(token.fundRewards(200));
    await tx(token.connect(s.wallets[1]).transfer(s.addresses[2], 100));
    assert.equal(await token.claimable(s.addresses[1]), 200n);
    assert.equal(await token.claimable(s.addresses[2]), 100n);
    await tx(token.fundRewards(100));
    assert.equal(await token.claimable(s.addresses[2]), 200n);
    await tx(token.connect(s.wallets[1]).claimRewards(s.addresses[1]));
    await tx(token.connect(s.wallets[1]).claimRewards(s.addresses[1]));
    assert.equal(await quote.balanceOf(s.addresses[1]), 200n);
    await tx(token.connect(s.wallets[2]).claimRewards(s.addresses[2]));
    assert.equal(await quote.balanceOf(s.addresses[2]), 200n);
    assert.equal(await token.totalClaimed(), await token.totalFunded());
    assert.equal(await token.claimable(s.addresses[0]), 0n);
    assert.equal(await token.totalSupply(), 1000n);
  } finally { await s.chain.disconnect(); }
});

test('random transfers and claims never create rewards, including self and excluded transfers', async () => {
  const s = await setup();
  try {
    const quote = await s.deploy('test/Fixtures.sol', 'MockQuote');
    const token = await s.deploy('contracts/LaunchToken.sol', 'LaunchToken', ['Launch', 'LCH', s.addresses[0], 10000, await quote.getAddress(), [s.addresses[5]], ZeroAddress, 0]);
    await tx(quote.approve(token, MaxUint256));
    await tx(token.transfer(s.addresses[1], 101));
    await tx(token.transfer(s.addresses[2], 103));
    await tx(token.transfer(s.addresses[5], 99));
    let seed = 42;
    const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let step = 0; step < 45; step++) {
      if (step % 3 === 0) await tx(token.fundRewards(rand(1000) + 1));
      const from = rand(6), to = rand(6);
      const balance = await token.balanceOf(s.addresses[from]);
      const amount = balance === 0n ? 0n : BigInt(rand(Number(balance) + 1));
      await tx(token.connect(s.wallets[from]).transfer(s.addresses[to], amount));
      if (step % 4 === 0) await tx(token.connect(s.wallets[to]).claimRewards(s.addresses[to]));
      const claims = await Promise.all(s.addresses.map(a => token.claimable(a)));
      const funded = await token.totalFunded(), claimed = await token.totalClaimed();
      assert.ok(claimed + claims.reduce((a,b) => a+b, 0n) <= funded);
      assert.equal(await quote.balanceOf(token), funded - claimed);
      const supply = await Promise.all(s.addresses.slice(1,5).map(a => token.balanceOf(a)));
      assert.equal(await token.eligibleSupply(), supply.reduce((a,b) => a+b, 0n));
      assert.equal(await token.claimable(s.addresses[5]), 0n);
    }
  } finally { await s.chain.disconnect(); }
});
