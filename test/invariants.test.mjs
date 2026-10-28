// Stateful fuzz test: seeded random sequences of buys, sells, transfers, reward and fee
// claims, round trips, time jumps, graduation, every pool trade type and buybacks, on an
// ETH-quoted and a 6-decimal USDC-quoted launch with odd fee settings. After every step it
// checks the accounting invariants that keep user funds safe.
// Reproduce a failure with FUZZ_SEED=<seed>; run longer with FUZZ_STEPS=<n>.
import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, MaxUint256, ZeroHash, keccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { CREATE2_PROXY, attach, deploySystem } from '../scripts/deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const PROXY_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const E18 = 10n ** 18n;
const SEED = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const STEPS = Number(process.env.FUZZ_STEPS ?? 140);

/// mulberry32: small deterministic PRNG so any failing sequence can be replayed from its seed.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)],
    // Log-uniform amount between lo and hi, so dust and large trades are both exercised.
    amount: (lo, hi) => { const l = Math.log(Number(lo)), h = Math.log(Number(hi)); return BigInt(Math.max(Number(lo), Math.floor(Math.exp(l + (h - l) * next())))); } };
}

test(`invariants hold under random trading (seed ${SEED}, ${STEPS} steps per launch)`, { timeout: 1_800_000 }, async () => {
  console.log(`# fuzz seed ${SEED}`);
  const r = rng(SEED);
  const connection = await network.create('local');
  try {
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    const w = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(i => provider.getSigner(i)));
    const a = await Promise.all(w.map(x => x.getAddress()));
    const rpc = (method, params = []) => connection.provider.request({ method, params });
    const advance = async seconds => { await rpc('evm_increaseTime', [seconds]); await rpc('evm_mine'); };
    const now = async () => BigInt((await provider.getBlock('latest')).timestamp);
    const tx = async p => { const rc = await (await p).wait(); assert.equal(rc.status, 1); return rc; };
    await rpc('hardhat_setCode', [CREATE2_PROXY, PROXY_RUNTIME]);
    const art = (file, name) => output.contracts[file]?.[name] ?? output.v4core[file][name];
    const deployArt = async (file, name, args = []) => {
      const c = await new ContractFactory(art(file, name).abi, art(file, name).evm.bytecode.object, w[0]).deploy(...args);
      await c.waitForDeployment(); return c;
    };
    const pm = await deployArt('@uniswap/v4-core/src/PoolManager.sol', 'PoolManager', [a[0]]);
    const weth = await deployArt('test/Fixtures.sol', 'MockWETH');
    const usdc = await deployArt('test/Fixtures.sol', 'MockUSDC');
    const platform = a[7];
    const config = { chainId: 31337, poolManager: await pm.getAddress(), poolManagerCodeHash: keccak256(await provider.getCode(pm)),
      weth: await weth.getAddress(), governor: a[0], platformRecipient: platform,
      launchConfig: { supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '1400000000000000000' },
      extraQuoteAssets: [await usdc.getAddress()],
      extraLaunchConfigs: [{ quote: await usdc.getAddress(), supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '4200000000' }] };
    const { contracts: c } = await deploySystem({ signer: w[0], artifacts: output.contracts, config });
    const at = (file, name, address, signer = w[0]) => attach(output.contracts, file, name, address, signer);
    const factory = at('contracts/LaunchFactory.sol', 'LaunchFactory', c.LaunchFactory);
    const escrow = at('contracts/FeeEscrow.sol', 'FeeEscrow', c.FeeEscrow);
    const vault = at('contracts/BuybackVestingVault.sol', 'BuybackVestingVault', c.BuybackVestingVault);
    const adapter = at('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', c.CanonicalBuybackAdapter);
    const locker = at('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', c.LiquidityLocker);
    const traders = w.slice(1, 6), traderAddrs = a.slice(1, 6);
    for (const t of a.slice(1, 6)) await tx(usdc.transfer(t, 10n ** 13n)); // 10M USDC each

    const launches = [
      { q: weth, native: true, configId: 0, creatorBps: 1000, holderShareBps: 5000, buybackShareBps: 3000, lo: 1000n, hi: E18 / 2n },
      { q: usdc, native: false, configId: 1, creatorBps: 37, holderShareBps: 3333, buybackShareBps: 1111, lo: 1n, hi: 2_000n * 10n ** 6n },
    ];
    for (const [i, L] of launches.entries()) {
      const creator = a[1 + i];
      L.quoteAddr = await L.q.getAddress();
      const p = { name: `Fuzz ${i}`, symbol: `FZ${i}`, metadataURI: '', creatorRecipient: creator, creatorBps: L.creatorBps,
        holderShareBps: L.holderShareBps, buybackShareBps: L.buybackShareBps, salt: '0x' + (i + 1).toString(16).padStart(64, '0'),
        expectedEconomics: await factory.previewEconomics(L.configId, L.quoteAddr), tokenSalt: ZeroHash, launchProtection: false, protectionExempt: [] };
      const [dep, , initHash] = await factory.tokenInitHash(creator, p, L.configId, L.quoteAddr);
      p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
      L.token = await factory.predictToken(creator, p, L.configId, L.quoteAddr);
      await tx(at('contracts/LaunchRouter.sol', 'LaunchRouter', c.LaunchRouter, w[1 + i]).launch(p, L.configId, L.quoteAddr, 0, 0, MaxUint256));
      L.curve = at('contracts/BondingCurve.sol', 'BondingCurve', (await factory.launches(L.token)).curve);
      L.tok = at('contracts/LaunchToken.sol', 'LaunchToken', L.token);
      L.creator = creator;
      for (const t of traders) {
        await tx(L.tok.connect(t).approve(c.LaunchRouter, MaxUint256));
        if (!L.native) await tx(usdc.connect(t).approve(c.LaunchRouter, MaxUint256));
      }
      L.trades = 0;
      L.ok = {};
    }

    const router = signer => at('contracts/LaunchRouter.sol', 'LaunchRouter', c.LaunchRouter, signer);
    const pay = (L, amount) => L.native ? { value: amount } : {};
    const tryTx = async p => { try { return await tx(p); } catch { return null; } };
    const quoteBal = async (L, who) => L.native ? await provider.getBalance(who) : await usdc.balanceOf(who);
    const gasCost = rc => rc.gasUsed * rc.gasPrice;

    async function checkInvariants(L, label) {
      const where = `${label} [seed ${SEED}]`;
      const phase = Number(await L.curve.phase());
      assert.notEqual(phase, 2, `graduation never stays pending ${where}`);
      if (phase === 1) {
        assert.equal(await L.q.balanceOf(L.curve), await L.curve.realQuoteReserve(), `curve quote balance == real reserve ${where}`);
        assert.equal(await L.tok.balanceOf(L.curve), (await L.curve.tokenReserve()) - (await L.curve.phantomTokens()), `curve token balance ${where}`);
      } else {
        assert.equal(await L.q.balanceOf(L.curve), 0n, `graduated curve holds no quote ${where}`);
        assert.ok(await locker.isLocked((await factory.launches(L.token)).poolId), `liquidity stays locked ${where}`);
      }
      // Nothing is ever left behind in the stateless contracts.
      for (const holder of [c.LaunchRouter, c.BloomFeeHook, c.LiquidityLocker, c.CanonicalBuybackAdapter]) {
        assert.equal(await L.q.balanceOf(holder), 0n, `${holder} holds no quote ${where}`);
        assert.equal(await L.tok.balanceOf(holder), 0n, `${holder} holds no tokens ${where}`);
      }
      assert.equal(await provider.getBalance(c.LaunchRouter), 0n, `router holds no ETH ${where}`);
      // Escrow is exactly backed, and every credit belongs to a known beneficiary.
      const liabilities = await escrow.liabilities(L.quoteAddr);
      assert.equal(await L.q.balanceOf(escrow), liabilities, `escrow balance == liabilities ${where}`);
      let credited = await escrow.balances(L.quoteAddr, platform);
      for (const t of traderAddrs) credited += await escrow.balances(L.quoteAddr, t);
      assert.equal(credited, liabilities, `escrow credits sum to liabilities ${where}`);
      // Buyback vault: quote fully backs pending funding; bought tokens back vesting lots.
      assert.equal(await L.q.balanceOf(vault), await vault.quoteLiabilities(L.quoteAddr), `vault quote == liabilities ${where}`);
      assert.ok(await L.tok.balanceOf(vault) >= await vault.tokenLiabilities(L.token), `vault tokens back lots ${where}`);
      // Holder rewards are solvent, and rounding dust stays bounded (no value silently lost).
      let owed = 0n;
      for (const t of traderAddrs) owed += await L.tok.claimable(t);
      const held = await L.q.balanceOf(L.token), pending = await L.tok.pendingRewards();
      assert.ok(held >= owed + pending, `rewards solvent: holds ${held}, owes ${owed} + pending ${pending} ${where}`);
      assert.ok(held - owed - pending <= BigInt(L.trades * 2 + 20), `reward dust ${held - owed - pending} too large ${where}`);
      assert.equal(await L.tok.totalSupply(), 10n ** 27n, `fixed supply ${where}`);
      assert.ok(await L.tok.excluded(c.LaunchRouter), `router never earns holder rewards ${where}`);
    }

    // Checks one trade's fee split against the onchain formula: platform 0.20%, creator rate, floor-rounded.
    function checkCurveFees(L, rc) {
      for (const log of rc.logs) {
        let ev; try { ev = L.curve.interface.parseLog(log); } catch { continue; }
        if (ev?.name !== 'Trade') continue;
        assert.equal(ev.args.platformFee, ev.args.grossQuote * 20n / 10_000n, `curve platform fee exact [seed ${SEED}]`);
        assert.equal(ev.args.creatorFee, ev.args.grossQuote * BigInt(L.creatorBps) / 10_000n, `curve creator fee exact [seed ${SEED}]`);
      }
    }
    const hookIface = at('contracts/v4/BloomFeeHook.sol', 'BloomFeeHook', c.BloomFeeHook).interface;
    function checkPoolFees(L, rc) {
      for (const log of rc.logs) {
        let ev; try { ev = hookIface.parseLog(log); } catch { continue; }
        if (ev?.name !== 'PoolFees') continue;
        assert.equal(ev.args.holderRewards + ev.args.buybackFunding + ev.args.creatorEarnings, ev.args.creatorFee, `creator fee fully allocated [seed ${SEED}]`);
        // platform = floor(g * 20 / 1e4) and creator = floor(g * bps / 1e4) for one gross g: cross-check the ratio.
        const lhs = ev.args.platformFee * BigInt(L.creatorBps), rhs = ev.args.creatorFee * 20n;
        assert.ok((lhs > rhs ? lhs - rhs : rhs - lhs) <= BigInt(Math.max(L.creatorBps, 20)), `pool fee rates consistent [seed ${SEED}]`);
      }
    }

    async function step(L, phase) {
      const i = r.int(traders.length), t = traders[i], ta = traderAddrs[i];
      const action = phase === 'curve'
        ? r.pick(['buy', 'buy', 'buy', 'sell', 'sell', 'transfer', 'claimRewards', 'claimFees', 'roundtrip', 'time'])
        : r.pick(['buy', 'buy', 'sell', 'sell', 'buyExactOut', 'sellExactOut', 'transfer', 'claimRewards', 'claimFees', 'roundtrip', 'time', 'buyback']);
      const dl = (await now()) + 600n;
      if (action === 'buy') {
        const amt = r.amount(L.lo, L.hi);
        const rc = await tryTx(router(t).buy(L.token, amt, 0, ta, dl, { ...pay(L, amt), gasLimit: 12_000_000n }));
        if (rc) { L.trades++; L.ok[`buy:${phase}`] = (L.ok[`buy:${phase}`] ?? 0) + 1; checkCurveFees(L, rc); checkPoolFees(L, rc); }
      } else if (action === 'sell') {
        const bal = await L.tok.balanceOf(ta);
        if (bal > 0n) {
          const amt = r.next() < 0.2 ? bal : bal * BigInt(1 + r.int(99)) / 100n;
          const rc = await tryTx(router(t).sell(L.token, amt, 0, ta, dl, L.native));
          if (rc) { L.trades++; L.ok[`sell:${phase}`] = (L.ok[`sell:${phase}`] ?? 0) + 1; checkCurveFees(L, rc); checkPoolFees(L, rc); }
        }
      } else if (action === 'buyExactOut') {
        const bal = await L.tok.balanceOf(c.LaunchRouter);
        const want = r.amount(10n ** 12n, 10n ** 24n), max = L.hi;
        const before = await L.tok.balanceOf(ta);
        const rc = await tryTx(router(t).buyExactOut(L.token, want, max, ta, dl, { ...pay(L, max), gasLimit: 12_000_000n }));
        if (rc) { L.trades++; L.ok.buyExactOut = (L.ok.buyExactOut ?? 0) + 1; checkPoolFees(L, rc); assert.ok((await L.tok.balanceOf(ta)) - before >= want, `exact-out delivered [seed ${SEED}]`); }
        assert.equal(bal, 0n);
      } else if (action === 'sellExactOut') {
        const bal = await L.tok.balanceOf(ta);
        if (bal > 0n) {
          const want = r.amount(L.lo, L.hi / 20n);
          const before = await quoteBal(L, ta);
          const rc = await tryTx(router(t).sellExactOut(L.token, want, bal, ta, dl, L.native));
          if (rc) {
            L.trades++; L.ok.sellExactOut = (L.ok.sellExactOut ?? 0) + 1; checkPoolFees(L, rc);
            const got = (await quoteBal(L, ta)) - before + (L.native ? gasCost(rc) : 0n);
            assert.ok(got >= want, `exact-out sell delivered ${got} < ${want} [seed ${SEED}]`);
          }
        }
      } else if (action === 'transfer') {
        const bal = await L.tok.balanceOf(ta);
        if (bal > 0n) await tx(L.tok.connect(t).transfer(r.pick(traderAddrs), bal * BigInt(r.int(101)) / 100n));
      } else if (action === 'claimRewards') {
        const owed = await L.tok.claimable(ta);
        const before = await L.q.balanceOf(ta);
        await tx(L.tok.connect(t).claimRewards(ta));
        assert.equal((await L.q.balanceOf(ta)) - before, owed, `reward claim pays exactly what is claimable [seed ${SEED}]`);
      } else if (action === 'claimFees') {
        const owed = await escrow.balances(L.quoteAddr, ta);
        const before = await L.q.balanceOf(ta);
        await tx(escrow.connect(t).claim(L.quoteAddr, ta));
        assert.equal((await L.q.balanceOf(ta)) - before, owed, `fee claim pays exactly the credit [seed ${SEED}]`);
      } else if (action === 'roundtrip') {
        // Buying and immediately selling everything bought must never return more than was paid.
        const amt = r.amount(L.lo, L.hi);
        const tokBefore = await L.tok.balanceOf(ta), qBefore = await quoteBal(L, ta);
        const rc1 = await tryTx(router(t).buy(L.token, amt, 0, ta, dl, { ...pay(L, amt), gasLimit: 12_000_000n }));
        if (rc1 && Number(await L.curve.phase()) !== 2) {
          const got = (await L.tok.balanceOf(ta)) - tokBefore;
          const rc2 = got > 0n ? await tryTx(router(t).sell(L.token, got, 0, ta, dl, L.native)) : null;
          const spentGas = L.native ? gasCost(rc1) + (rc2 ? gasCost(rc2) : 0n) : 0n;
          const net = (await quoteBal(L, ta)) + spentGas - qBefore;
          assert.ok(net <= 0n, `round trip profited ${net} [seed ${SEED}]`);
          L.trades += rc2 ? 2 : 1;
          if (rc2) L.ok[`roundtrip:${phase}`] = (L.ok[`roundtrip:${phase}`] ?? 0) + 1;
        }
      } else if (action === 'time') {
        await advance(1 + r.int(900));
      } else if (action === 'buyback') {
        const pendingFunding = await vault.pending(L.token, L.creator);
        if (pendingFunding > 0n) {
          const [minTokens, maxInput] = await adapter.limits(L.token, L.quoteAddr, pendingFunding);
          const amt = pendingFunding < maxInput ? pendingFunding : maxInput;
          if (minTokens > 0n && amt > 0n) await tryTx(vault.execute(L.token, L.creator, amt, (await now()) + 240n));
        }
      }
      await checkInvariants(L, `after ${action} (${phase})`);
    }

    for (const L of launches) {
      for (let s = 0; s < STEPS; s++) await step(L, 'curve');
      // Graduate with the exact completing amount plus extra; the router must refund the excess.
      if (Number(await L.curve.phase()) === 1) {
        const [, gross] = await L.curve.quoteBuy(10n ** 40n);
        const extra = gross / 7n + 1n;
        const before = await quoteBal(L, traderAddrs[0]);
        const rc = await tx(router(traders[0]).buy(L.token, gross + extra, 0, traderAddrs[0], (await now()) + 600n,
          { ...pay(L, gross + extra), gasLimit: 12_000_000n }));
        const spent = before - (await quoteBal(L, traderAddrs[0])) - (L.native ? gasCost(rc) : 0n);
        assert.ok(spent <= gross, `graduating buy charged ${spent} for a ${gross} completion [seed ${SEED}]`);
        L.trades++;
      }
      assert.equal(Number(await L.curve.phase()), 3, `graduated [seed ${SEED}]`);
      await checkInvariants(L, 'after graduation');
      for (let s = 0; s < STEPS; s++) await step(L, 'pool');
      // Failed trades are tolerated individually (slippage, dust), but every trade type must work.
      for (const key of ['buy:curve', 'sell:curve', 'roundtrip:curve', 'buy:pool', 'sell:pool', 'buyExactOut', 'sellExactOut'])
        assert.ok(L.ok[key] > 0, `no successful ${key} in ${STEPS} steps: ${JSON.stringify(L.ok)} [seed ${SEED}]`);
    }
  } finally {
    await connection.close();
  }
});

test(`fee maths: exact fees, full allocation and minimal gross-for-net on random inputs (seed ${SEED})`, { timeout: 600_000 }, async () => {
  const r = rng(SEED ^ 0x5eed);
  const connection = await network.create('local');
  try {
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    const signer = await provider.getSigner(0);
    const a = output.contracts['test/Fixtures.sol'].FeeHarness;
    const h = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy();
    await h.waitForDeployment();
    for (let i = 0; i < 400; i++) {
      const rate = BigInt(r.pick([0, 1, 7, 37, 100, 333, 999, 1000, r.int(1001)]));
      const net = r.next() < 0.3 ? BigInt(r.int(1000)) : r.amount(1n, 10n ** 30n);
      const gross = await h.grossForNet(net, rate);
      const [p1, c1, n1] = await h.fees(gross, rate);
      assert.equal(p1, gross * 20n / 10_000n, 'platform fee is floor(0.20%)');
      assert.equal(c1, gross * rate / 10_000n, 'creator fee is floor(rate)');
      assert.equal(p1 + c1 + n1, gross, 'fees and net add up to gross');
      assert.ok(n1 >= net, `gross ${gross} covers net ${net} at ${rate}`);
      if (gross > 0n) { const [, , prev] = await h.fees(gross - 1n, rate); assert.ok(prev < net, `gross ${gross} is minimal for ${net} at ${rate}`); }
      const hb = BigInt(r.int(10_001)), bb = BigInt(r.int(10_001 - Number(hb)));
      const [cr, ho, bu] = await h.allocate(c1, hb, bb);
      assert.equal(cr + ho + bu, c1, 'creator fee fully allocated');
    }
  } finally {
    await connection.close();
  }
});
