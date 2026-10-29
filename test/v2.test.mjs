import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, Interface, MaxUint256, ZeroHash, keccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { CREATE2_PROXY, attach, deploySystemV2, launchBloom } from '../scripts/deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const PROXY_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const E18 = 10n ** 18n;
const tx = async p => (await p).wait();
// The Uniswap V3 pool interface, exactly as indexers use it.
const V3 = new Interface([
  'event Initialize(uint160 sqrtPriceX96, int24 tick)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function factory() view returns (address)',
  'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)', 'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);
const isqrt = n => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const events = (rc, name) => rc.logs.map(l => { try { return V3.parseLog(l); } catch { return null; } }).filter(e => e?.name === name);

test('v2: own BLOOM, launch fee + mandatory dev buy, Uniswap V3-style pool interface and events, BLOOM burn', async () => {
  const connection = await network.create('local');
  try {
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 20;
    const w = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(i => provider.getSigner(i)));
    const a = await Promise.all(w.map(x => x.getAddress()));
    const rpc = (method, params = []) => connection.provider.request({ method, params });
    const advance = async s => { await rpc('evm_increaseTime', [s]); await rpc('evm_mine'); };
    const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp) + 600n;
    await rpc('hardhat_setCode', [CREATE2_PROXY, PROXY_RUNTIME]);
    const art = (file, name) => output.contracts[file]?.[name] ?? output.v4core[file][name];
    const deployArt = async (file, name, args = []) => {
      const c = await new ContractFactory(art(file, name).abi, art(file, name).evm.bytecode.object, w[0]).deploy(...args);
      await c.waitForDeployment(); return c;
    };
    const pm = await deployArt('@uniswap/v4-core/src/PoolManager.sol', 'PoolManager', [a[0]]);
    const weth = await deployArt('test/Fixtures.sol', 'MockWETH');
    const treasury = a[6];
    const config = { chainId: 31337, poolManager: await pm.getAddress(), poolManagerCodeHash: keccak256(await provider.getCode(pm)),
      weth: await weth.getAddress(), governor: a[0], platformRecipient: treasury, bloomBurnBps: 5000,
      launchConfig: { supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '1400000000000000000' } };
    // Complete v2 system with its own BLOOM: fee 0.00004 ETH, minimum dev buy 0.00002 ETH.
    const FEE = 4n * 10n ** 13n, MIN_BUY = 2n * 10n ** 13n;
    const v2 = await deploySystemV2({ signer: w[0], artifacts: output.contracts, config, launchFee: FEE, minInitialBuy: MIN_BUY });
    const c = v2.contracts;
    const { bloom, vesting } = await launchBloom({ signer: w[0], artifacts: output.contracts, contracts: c, weth: config.weth, team: a[3], mineTokenSalt, v2: true });
    const at = (file, name, address, signer = w[0]) => attach(output.contracts, file, name, address, signer);
    const burner = at('contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', c.BloomBuybackBurner);
    assert.equal(await burner.bloom(), bloom);
    assert.ok(bloom.toLowerCase().endsWith('b00b'));
    const bloomToken = at('contracts/LaunchToken.sol', 'LaunchToken', bloom);
    assert.equal(await bloomToken.balanceOf(vesting), 10n ** 26n, 'v2 BLOOM: 100M team reserve in vesting');
    assert.equal(c.MigrationFactory, undefined, 'no v1 migration factory on v2');
    const factory = at('contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', c.LaunchFactory);
    const router = at('contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', c.LaunchRouter, w[1]);
    const escrow = at('contracts/FeeEscrow.sol', 'FeeEscrow', c.FeeEscrow);
    assert.equal(await factory.launchFee(), FEE);
    assert.equal(await factory.minInitialBuy(), MIN_BUY);

    // Governor limits: capped, owner only.
    await assert.rejects(factory.setLaunchTerms(10n ** 15n + 1n, 0), 'fee cap');
    await assert.rejects(factory.setLaunchTerms(0, 10n ** 15n + 1n), 'min buy cap');
    await assert.rejects(factory.connect(w[1]).setLaunchTerms(0, 0), 'owner only');
    await assert.rejects(factory.launchFor(a[1], {}, 0, config.weth), 'only the router launches');

    const creator = a[1];
    const params = { name: 'Vee Two', symbol: 'VTWO', metadataURI: '', creatorRecipient: creator, creatorBps: 100, holderShareBps: 5000,
      buybackShareBps: 0, salt: '0x' + '22'.repeat(32), expectedEconomics: await factory.previewEconomics(0, config.weth), tokenSalt: ZeroHash,
      launchProtection: false, protectionExempt: [] };
    const [dep, , initHash] = await factory.tokenInitHash(creator, params, 0, config.weth);
    params.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
    const token = await factory.predictToken(creator, params, 0, config.weth);

    // Launch rules: dev buy below the minimum, missing fee, or wrong quote are refused.
    await assert.rejects(router.launch(params, 0, config.weth, MIN_BUY - 1n, 0, await deadline(), { value: FEE + MIN_BUY - 1n }), 'dev buy too small');
    await assert.rejects(router.launch(params, 0, config.weth, MIN_BUY, 0, await deadline(), { value: MIN_BUY }), 'fee not paid');
    await assert.rejects(router.launch(params, 0, config.weth, 0, 0, await deadline(), { value: FEE }), 'no dev buy');

    const devBuy = 5n * 10n ** 13n;
    const rc = await tx(router.launch(params, 0, config.weth, devBuy, 1, await deadline(), { value: FEE + devBuy }));
    assert.ok(token.toLowerCase().endsWith('b00b'));
    const curveAddr = (await factory.launches(token)).curve;
    const tokenC = at('contracts/LaunchToken.sol', 'LaunchToken', token);
    assert.ok(await tokenC.balanceOf(creator) > 0n, 'creator got the dev buy');
    assert.ok(await escrow.balances(config.weth, c.BloomBuybackBurner) >= FEE, 'launch fee escrowed to platform revenue (the BLOOM burner)');

    // PoolCreated (V3 factory event) announces the curve as a pool.
    const created = events(rc, 'PoolCreated');
    assert.equal(created.length, 1);
    const [t0, t1] = BigInt(config.weth) < BigInt(token) ? [config.weth, token] : [token, config.weth];
    assert.equal(created[0].args.token0, t0); assert.equal(created[0].args.token1, t1);
    assert.equal(created[0].args.pool, curveAddr);
    assert.equal(created[0].args.fee, 12000n, '0.20% + 1% in hundredths of a bip');
    assert.equal(events(rc, 'Initialize').length, 1);

    // The curve answers the V3 pool views, consistent with its reserves.
    const pool = new Contract(curveAddr, V3, provider);
    const curve = at('contracts/v2/BondingCurveV2.sol', 'BondingCurveV2', curveAddr);
    assert.equal(await pool.token0(), t0); assert.equal(await pool.token1(), t1);
    assert.equal(await pool.factory(), c.LaunchFactory);
    assert.equal(await pool.fee(), 12000n);
    const checkPrice = async (sqrtP, tick, label) => {
      const q = await curve.quoteReserve(), t = await curve.tokenReserve();
      const [r0, r1] = t0 === config.weth ? [q, t] : [t, q];
      assert.equal(sqrtP, isqrt(r1 * (1n << 192n) / r0), `${label}: sqrtPriceX96 matches reserves`);
      const ideal = Math.floor(Math.log((Number(sqrtP) / 2 ** 96) ** 2) / Math.log(1.0001));
      assert.ok(Math.abs(Number(tick) - ideal) <= 1, `${label}: tick ${tick} vs ${ideal}`);
    };
    const s0 = await pool.slot0();
    await checkPrice(s0.sqrtPriceX96, s0.tick, 'slot0');
    assert.equal(await pool.liquidity(), isqrt(await curve.quoteReserve() * await curve.tokenReserve()));

    // Dev buy Swap event: WETH in (positive, gross), tokens out (negative), as Uniswap V3 reports it.
    const devSwap = events(rc, 'Swap');
    assert.equal(devSwap.length, 1);
    const [wethDelta, tokenDelta] = t0 === config.weth ? [devSwap[0].args.amount0, devSwap[0].args.amount1] : [devSwap[0].args.amount1, devSwap[0].args.amount0];
    assert.equal(wethDelta, devBuy);
    assert.equal(-tokenDelta, await tokenC.balanceOf(creator));
    assert.equal(devSwap[0].args.recipient, creator);

    // Ordinary buy and sell through the router emit V3 Swap events too.
    const buyer = w[2], b = a[2];
    const r2 = await tx(router.connect(buyer).buy(token, E18 / 10n, 1, b, await deadline(), { value: E18 / 10n }));
    const buySwap = events(r2, 'Swap')[0];
    await checkPrice(buySwap.args.sqrtPriceX96, buySwap.args.tick, 'buy event');
    assert.equal(buySwap.args.liquidity, await pool.liquidity());
    const held = await tokenC.balanceOf(b);
    await tx(tokenC.connect(buyer).approve(c.LaunchRouter, held));
    const ethBefore = await provider.getBalance(b);
    const r3 = await tx(router.connect(buyer).sell(token, held / 2n, 1, b, await deadline(), true));
    const sellSwap = events(r3, 'Swap')[0];
    const [sw, st] = t0 === config.weth ? [sellSwap.args.amount0, sellSwap.args.amount1] : [sellSwap.args.amount1, sellSwap.args.amount0];
    assert.equal(st, held / 2n, 'tokens into the pool are positive');
    assert.ok(sw < 0n, 'WETH out is negative');
    assert.equal(-sw, (await provider.getBalance(b)) - ethBefore + r3.gasUsed * r3.gasPrice, 'WETH out equals what the seller received');

    // Graduation: the completing buy moves trading to the locked V4 pool; the curve reports zero liquidity.
    const [, gross] = await curve.quoteBuy(10n ** 40n);
    await tx(router.connect(buyer).buy(token, gross + E18, 1, b, await deadline(), { value: gross + E18, gasLimit: 12_000_000n }));
    assert.equal(Number(await curve.phase()), 3);
    assert.equal(await pool.liquidity(), 0n);
    const fin = await pool.slot0();
    assert.ok(fin.sqrtPriceX96 > 0n, 'finished curve still reports its final price');
    await tx(router.connect(buyer).buy(token, E18 / 100n, 1, b, await deadline(), { value: E18 / 100n }));

    // Platform revenue (launch fee + trading fees) splits 50% into the BLOOM burn, 50% treasury.
    const owed = await escrow.balances(config.weth, c.BloomBuybackBurner);
    const burnBefore = await burner.burnPending(), treasuryBefore = await weth.balanceOf(treasury);
    await tx(burner.connect(w[5]).claim(config.weth));
    const toBurn = owed * 5000n / 10_000n;
    assert.equal(await burner.burnPending() - burnBefore, toBurn);
    assert.equal(await weth.balanceOf(treasury) - treasuryBefore, owed - toBurn);
    assert.equal(await escrow.balances(config.weth, c.BloomBuybackBurner), 0n);

    // v2 BLOOM: graduates and the burn buys BLOOM on its pool and burns it.
    const bloomCurve = at('contracts/v2/BondingCurveV2.sol', 'BondingCurveV2', (await factory.launches(bloom)).curve);
    await advance(301);
    const [, bloomGross] = await bloomCurve.quoteBuy(10n ** 40n);
    await tx(router.connect(buyer).buy(bloom, bloomGross + E18, 1, b, await deadline(), { value: bloomGross + E18, gasLimit: 12_000_000n }));
    assert.equal(Number(await bloomCurve.phase()), 3, 'v2 BLOOM graduated');
    const moreFees = await escrow.balances(config.weth, c.BloomBuybackBurner);
    if (moreFees > 0n) await tx(burner.claim(config.weth));
    for (let i = 0; i < 4; i++) { await advance(600); await tx(router.connect(buyer).buy(bloom, E18 / 100n, 1, b, await deadline(), { value: E18 / 100n })); }
    const pending = await burner.burnPending();
    const adapter = at('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', c.BloomBurnAdapter);
    // The burn refuses while the price is moving away from its 30-minute average (here: +104 ticks after
    // a run of buys), so it cannot be executed into a pushed price. Once the market settles it runs.
    const [refused] = await adapter.limits(bloom, config.weth, pending);
    assert.equal(refused, 0n, 'burn refused while spot is >100 ticks from the 30-minute average');
    await advance(1900);
    const [, maxInput] = await adapter.limits(bloom, config.weth, pending);
    await tx(burner.executeBurn(pending < maxInput ? pending : maxInput, await deadline() - 360n));
    assert.ok(await burner.totalBurned() > 0n, 'BLOOM bought and burned');
  } finally {
    await connection.close();
  }
});
