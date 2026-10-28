// End-to-end wiring check against a live BloomLaunch deployment (Robinhood Chain testnet).
// Usage:
//   node scripts/testnet-check.mjs            # phase 1: wiring reads, launch, protection, trades,
//                                             # limit orders, graduation, pool trades, fees, BLOOM
//   node scripts/testnet-check.mjs --phase2   # 30+ minutes later: buyback and BLOOM burn (need the TWAP window)
// Reads deployments/<chainId>.json and the throwaway signer from .env.testnet. Never point it at mainnet.
import fs from 'node:fs';
import { JsonRpcProvider, NonceManager, Wallet, Contract, ZeroHash, getAddress, hexlify, randomBytes } from 'ethers';
import { attach } from './deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const env = Object.fromEntries(fs.readFileSync('.env.testnet', 'utf8').split('\n')
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const { chainId } = await provider.getNetwork();
if (chainId === 4663n) throw new Error('refusing to run the wiring check on mainnet');
const wallet = new Wallet(env.DEPLOYER_PRIVATE_KEY, provider);
const me = new NonceManager(wallet);
me.address = wallet.address;
const deployment = JSON.parse(fs.readFileSync(`deployments/${chainId}.json`, 'utf8'));
const artifacts = JSON.parse(fs.readFileSync('artifacts/production.json', 'utf8'));
const c = deployment.contracts, weth = deployment.config.weth;
const stateFile = `deployments/${chainId}-check.json`;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { results: {} };

const at = (file, name, address) => attach(artifacts, file, name, address, me);
const factory = at('contracts/LaunchFactory.sol', 'LaunchFactory', c.LaunchFactory);
const router = at('contracts/LaunchRouter.sol', 'LaunchRouter', c.LaunchRouter);
const escrow = at('contracts/FeeEscrow.sol', 'FeeEscrow', c.FeeEscrow);
const vault = at('contracts/BuybackVestingVault.sol', 'BuybackVestingVault', c.BuybackVestingVault);
const adapter = at('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', c.CanonicalBuybackAdapter);
const burnAdapter = at('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', c.BloomBurnAdapter);
const locker = at('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', c.LiquidityLocker);
const hook = at('contracts/v4/BloomFeeHook.sol', 'BloomFeeHook', c.BloomFeeHook);
const burner = at('contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', c.BloomBuybackBurner);
const limits = at('contracts/LimitOrderExecutor.sol', 'LimitOrderExecutor', c.LimitOrderExecutor);
const migrations = at('contracts/migration/MigrationFactory.sol', 'MigrationFactory', c.MigrationFactory);
const curveAt = a => at('contracts/BondingCurve.sol', 'BondingCurve', a);
const tokenAt = a => at('contracts/LaunchToken.sol', 'LaunchToken', a);
const wethC = new Contract(weth, ['function deposit() payable', 'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)'], me);

const GAS = { gasLimit: 8_000_000n };
const now = async () => BigInt((await provider.getBlock('latest')).timestamp);
const deadline = async () => (await now()) + 600n;
const wait = async tx => { const r = await (await tx).wait(); if (r.status !== 1) throw new Error(`tx ${r.hash} failed`); return r; };
const eq = (a, b) => getAddress(a) === getAddress(b);
let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    state.results[name] = { ok: true, detail: detail ?? '' };
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    failures++;
    state.results[name] = { ok: false, detail: (e.shortMessage ?? e.message).slice(0, 300) };
    console.log(`FAIL  ${name}  ${(e.shortMessage ?? e.message).slice(0, 300)}`);
  }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const fmt = (v, d = 18) => (Number(v) / 10 ** d).toPrecision(4);
const ME = me.address;

if (!process.argv.includes('--phase2')) {
  console.log(`signer ${ME} balance ${fmt(await provider.getBalance(ME))} ETH on chain ${chainId}`);

  await check('wiring: factory, locker, hook, vault, adapters, router, burner', async () => {
    must(eq(await factory.locker(), c.LiquidityLocker), 'factory.locker');
    must(eq(await factory.escrow(), c.FeeEscrow), 'factory.escrow');
    must(eq(await factory.buybackVault(), c.BuybackVestingVault), 'factory.buybackVault');
    must(eq(await factory.platformRecipient(), c.BloomBuybackBurner), 'platform fees go to the BLOOM burner');
    must(eq(await factory.router(), c.LaunchRouter), 'factory.router');
    must(eq(await locker.factory(), c.LaunchFactory) && eq(await locker.feeHook(), c.BloomFeeHook), 'locker binding');
    must(eq(await hook.factory(), c.LaunchFactory), 'hook.factory');
    must(eq(await vault.factory(), c.LaunchFactory), 'vault.factory');
    must(eq(await adapter.vault(), c.BuybackVestingVault), 'adapter.vault');
    must(eq(await burnAdapter.vault(), c.BloomBuybackBurner), 'burn adapter vault');
    must(eq(await burner.bloom(), deployment.bloom), 'burner.bloom');
    must(eq(await burner.treasury(), deployment.config.platformRecipient), 'burner.treasury');
    must(Number(await burner.burnBps()) === 5000, 'burn share 50%');
    must(eq(await router.factory(), c.LaunchFactory) && eq(await router.weth(), weth), 'router wiring');
    must(eq(await limits.router(), c.LaunchRouter), 'limit executor router');
    must(eq(await migrations.owner(), deployment.config.governor), 'migration factory owner');
    must(eq(await factory.platformToken(), deployment.bloom), 'BLOOM registered as platform token');
    return `owner ${await factory.owner()}`;
  });

  // ---- Launch a test coin with snipe protection, a creator fee and holder/buyback shares ----
  let token = state.token;
  await check('launch: gas-only launch with first buy, address ends in b00b', async () => {
    if (token) return `reused ${token}`;
    const quote = weth, configId = 0;
    const p = { name: 'Testnet Petal', symbol: 'TPETAL', metadataURI: '', creatorRecipient: ME, creatorBps: 300,
      holderShareBps: 5000, buybackShareBps: 2000, salt: hexlify(randomBytes(32)), expectedEconomics: await factory.previewEconomics(configId, quote),
      tokenSalt: ZeroHash, launchProtection: true, protectionExempt: [] };
    const [dep, , initHash] = await factory.tokenInitHash(ME, p, configId, quote);
    p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
    token = await factory.predictToken(ME, p, configId, quote);
    const first = 2n * 10n ** 13n;
    const balBefore = await provider.getBalance(ME);
    await wait(router.launch(p, configId, quote, first, 0, await deadline(), { value: first, ...GAS }));
    must(token.toLowerCase().endsWith('b00b'), `address ${token}`);
    state.token = token;
    return `${token}, cost ${fmt(balBefore - await provider.getBalance(ME))} ETH incl. gas`;
  });
  const curve = curveAt((await factory.launches(token)).curve);
  const tok = tokenAt(token);

  await check('snipe protection: blocks >1% buys for other wallets, creator can end it', async () => {
    const other = Wallet.createRandom().address;
    if (await curve.protectionActive()) {
      let blocked = false;
      try { await router.buy.staticCall(token, 10n ** 13n, 0, other, await deadline(), { value: 10n ** 13n }); }
      catch { blocked = true; }
      must(blocked, 'large buy for another wallet was not blocked');
      await router.buy.staticCall(token, 10n ** 11n, 0, other, await deadline(), { value: 10n ** 11n });
      await wait(factory.endProtection(token));
    }
    must(!(await curve.protectionActive()), 'protection still active');
    await router.buy.staticCall(token, 10n ** 13n, 0, other, await deadline(), { value: 10n ** 13n });
    return 'blocked while on; allowed after the creator ended it';
  });

  await check('curve: buy and sell through the router (native ETH)', async () => {
    if (Number(await curve.phase()) !== 1) return 'already past the curve';
    const before = await tok.balanceOf(ME);
    await wait(router.buy(token, 10n ** 13n, 1, ME, await deadline(), { value: 10n ** 13n, ...GAS }));
    const bought = (await tok.balanceOf(ME)) - before;
    must(bought > 0n, 'no tokens received');
    await wait(tok.approve(c.LaunchRouter, bought / 2n));
    const eth = await provider.getBalance(ME);
    await wait(router.sell(token, bought / 2n, 1, ME, await deadline(), true, GAS));
    return `bought ${fmt(bought)} TPETAL, sold half`;
  });

  await check('limit orders: signed sell and buy orders filled by the executor', async () => {
    if (Number(await curve.phase()) !== 1) return 'already past the curve';
    const domain = { name: 'BloomLaunch Limit Orders', version: '1', chainId, verifyingContract: c.LimitOrderExecutor };
    const types = { Order: [{ name: 'maker', type: 'address' }, { name: 'token', type: 'address' }, { name: 'buy', type: 'bool' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] };
    const expiry = (await now()) + 3600n;
    const sellIn = (await tok.balanceOf(ME)) / 10n;
    const sellOrder = { maker: ME, token, buy: false, amountIn: sellIn, minAmountOut: 1n, expiry, nonce: BigInt(hexlify(randomBytes(8))) };
    await wait(tok.approve(c.LimitOrderExecutor, sellIn));
    await wait(limits.fill(sellOrder, await wallet.signTypedData(domain, types, sellOrder), GAS));
    must(await limits.nonceUsed(ME, sellOrder.nonce), 'sell nonce not used');
    const buyIn = 2n * 10n ** 12n;
    await wait(wethC.deposit({ value: buyIn }));
    await wait(wethC.approve(c.LimitOrderExecutor, buyIn));
    const buyOrder = { maker: ME, token, buy: true, amountIn: buyIn, minAmountOut: 1n, expiry, nonce: BigInt(hexlify(randomBytes(8))) };
    await wait(limits.fill(buyOrder, await wallet.signTypedData(domain, types, buyOrder), GAS));
    must(await limits.nonceUsed(ME, buyOrder.nonce), 'buy nonce not used');
    return 'both orders filled at or better than their limits';
  });

  await check('graduation: final buy creates a locked Uniswap V4 pool', async () => {
    if (Number(await curve.phase()) === 1) {
      const [, gross] = await curve.quoteBuy(10n ** 40n);
      const pay = gross + gross / 100n;
      await wait(router.buy(token, pay, 1, ME, await deadline(), { value: pay, gasLimit: 10_000_000n }));
    }
    const launch = await factory.launches(token);
    must(Number(await curve.phase()) === 3, `phase ${await curve.phase()}`);
    must(launch.poolId !== ZeroHash, 'no pool id');
    must(await locker.isLocked(launch.poolId), 'liquidity not locked');
    state.graduatedAt = state.graduatedAt ?? Number(await now());
    return `pool ${launch.poolId.slice(0, 18)}…`;
  });

  await check('pool: exact-in buy, exact-in sell and exact-out buy via the router', async () => {
    const before = await tok.balanceOf(ME);
    await wait(router.buy(token, 10n ** 12n, 1, ME, await deadline(), { value: 10n ** 12n, ...GAS }));
    const got = (await tok.balanceOf(ME)) - before;
    must(got > 0n, 'pool buy returned nothing');
    await wait(tok.approve(c.LaunchRouter, got / 2n));
    await wait(router.sell(token, got / 2n, 1, ME, await deadline(), true, GAS));
    const want = got / 10n, max = 10n ** 12n;
    const b2 = await tok.balanceOf(ME);
    await wait(router.buyExactOut(token, want, max, ME, await deadline(), { value: max, ...GAS }));
    must((await tok.balanceOf(ME)) - b2 >= want, 'exact-out amount short');
    return `pool bought ${fmt(got)} TPETAL`;
  });

  await check('fees: creator earnings and platform revenue escrowed, creator can claim', async () => {
    const creator = await escrow.balances(weth, ME), platform = await escrow.balances(weth, c.BloomBuybackBurner);
    must(platform > 0n, 'no platform revenue');
    must(creator > 0n, 'no creator earnings');
    await wait(escrow.claim(weth, ME));
    must(await escrow.balances(weth, ME) === 0n, 'claim did not clear balance');
    return `creator claimed ${fmt(creator)} WETH, platform holds ${fmt(platform)} WETH`;
  });

  await check('holder rewards: accrue to holders and can be claimed', async () => {
    const owed = await tok.claimable(ME);
    must(owed > 0n, 'nothing claimable');
    await wait(tok.claimRewards(ME));
    return `claimed ${fmt(owed)} WETH`;
  });

  await check('buybacks: creator buyback share funded into the vault', async () => {
    const pending = await vault.pending(token, ME);
    must(pending > 0n, 'no buyback funding');
    return `${fmt(pending)} WETH waiting (executes in phase 2 once the 30-minute price average exists)`;
  });

  const bloomCurve = curveAt((await factory.launches(deployment.bloom)).curve);
  await check('BLOOM: graduates and platform revenue splits 50% burn / 50% treasury', async () => {
    if (Number(await bloomCurve.phase()) === 1) {
      if (await bloomCurve.protectionActive()) {
        const wait = Number(await bloomCurve.launchedAt()) + 300 - Number(await now()) + 5;
        console.log(`      waiting ${wait}s for BLOOM's opening protection to end`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
      const [, gross] = await bloomCurve.quoteBuy(10n ** 40n);
      const pay = gross + gross / 100n;
      await wait(router.buy(deployment.bloom, pay, 1, ME, await deadline(), { value: pay, gasLimit: 10_000_000n }));
      state.bloomGraduatedAt = Number(await now());
    }
    must(Number(await bloomCurve.phase()) === 3, 'BLOOM did not graduate');
    const owed = await escrow.balances(weth, c.BloomBuybackBurner);
    if (owed > 0n) await wait(burner.claim(weth));
    const pending = await burner.burnPending(), sent = await burner.toTreasury(weth);
    must(pending > 0n && sent > 0n, 'revenue not split');
    return `burn pending ${fmt(pending)} WETH, treasury got ${fmt(sent)} WETH`;
  });

  await check('team BLOOM: 100M reserve, 50M unlocked at launch, 50M vesting over 12 months', async () => {
    const vesting = new Contract(deployment.teamVesting, ['function owner() view returns (address)', 'function duration() view returns (uint256)',
      'function immediateBps() view returns (uint256)', 'function releasable(address) view returns (uint256)', 'function released(address) view returns (uint256)'], provider);
    const held = await tokenAt(deployment.bloom).balanceOf(deployment.teamVesting);
    const released = await vesting.released(deployment.bloom), unlocked = await vesting.releasable(deployment.bloom);
    must(held + released === 10n ** 26n, `reserve is ${held + released}`);
    must(Number(await vesting.immediateBps()) === 5000, 'immediate share is not 50%');
    must(released + unlocked >= 5n * 10n ** 25n && released + unlocked < 51n * 10n ** 24n, `unlocked ${released + unlocked}`);
    must(Number(await vesting.duration()) === 365 * 86400, 'vesting is not 12 months');
    return `50M unlocked now, the rest vesting to ${await vesting.owner()}`;
  });
  await check('rewards: router never earns holder rewards (fix from the fuzz review)', async () => {
    must(await tok.excluded(c.LaunchRouter), 'router is not excluded');
    must(await tokenAt(deployment.bloom).excluded(c.LaunchRouter), 'router is not excluded on BLOOM');
    return 'excluded on TPETAL and BLOOM';
  });
} else {
  const token = state.token;
  must(token, 'run phase 1 first');
  await check('buyback: vault buys the coin on its pool at the time-weighted price and vests it', async () => {
    const pending = await vault.pending(token, ME);
    const [minTokens, maxInput] = await adapter.limits(token, weth, pending);
    must(minTokens > 0n, 'price average not ready or spot too far from it (try again later)');
    const amount = pending < maxInput ? pending : maxInput;
    await wait(vault.execute(token, ME, amount, (await now()) + 240n, GAS));
    must(await vault.lotCount(token, ME) > 0n, 'no vesting lot');
    return `spent ${fmt(amount)} WETH`;
  });
  await check('BLOOM burn: platform revenue buys BLOOM and sends it to the dead address', async () => {
    const pending = await burner.burnPending();
    const [minTokens, maxInput] = await burnAdapter.limits(deployment.bloom, weth, pending);
    must(minTokens > 0n, 'price average not ready or spot too far from it (try again later)');
    const amount = pending < maxInput ? pending : maxInput;
    await wait(burner.executeBurn(amount, (await now()) + 240n, GAS));
    return `burned ${fmt(await burner.totalBurned())} BLOOM for ${fmt(await burner.totalSpent())} WETH`;
  });
}

console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}; results in ${stateFile}`);
process.exit(failures ? 1 : 0);
