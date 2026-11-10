// Pre-deploy dry run on a local fork of Elysium mainnet: the real WHYPE, Uniswap V4 PoolManager and
// CREATE2 deployer, with the configured deployer impersonated. Runs the exact mainnet deploy (system,
// proxies, BLOOM), then a user launch, trades, graduation into the locked V4 pool, pool trades and the
// BLOOM burn, and reports the gas the real deploy will need. Nothing is sent to the real chain.
// Usage: node scripts/fork-dryrun.mjs [config/deploy.elysium-mainnet.json]   (FORK_URL optional)
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner, ZeroHash, formatEther, parseEther } from 'ethers';
import { output } from './compile.mjs';
import { attach, deploySystem, launchBloom } from './deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2] ?? 'config/deploy.elysium-mainnet.json', 'utf8'));
const connection = await network.create('elysiumFork');
const rpc = (method, params = []) => connection.provider.request({ method, params });
const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
provider.pollingInterval = 50;
const artifacts = output.contracts;
const at = (file, name, address, runner) => attach(artifacts, file, name, address, runner);
const advance = async s => { await rpc('evm_increaseTime', [s]); await rpc('evm_mine'); };
const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp) + 600n;
const step = (label, detail = '') => console.log(`ok  ${label}${detail ? `  (${detail})` : ''}`);

const forkBlock = await provider.getBlockNumber();
const { gasPrice } = await provider.getFeeData();
console.log(`fork of chain ${(await provider.getNetwork()).chainId} at block ${forkBlock}, gas price ${Number(gasPrice) / 1e9} gwei`);

// The real deployer, impersonated with test HYPE (the fork's balances are local only).
await rpc('hardhat_impersonateAccount', [config.deployer]);
await rpc('hardhat_setBalance', [config.deployer, '0x' + parseEther('10').toString(16)]);
const deployer = new JsonRpcSigner(provider, config.deployer);   // impersonated (no wallet prompt on a fork)
const nonce0 = await provider.getTransactionCount(config.deployer);

// 1) The exact mainnet deploy: proxied system + BLOOM.
const result = await deploySystem({ signer: deployer, artifacts, config, v2: true,
  launchFee: BigInt(config.launchFeeWei ?? 0), minInitialBuy: BigInt(config.minInitialBuyWei ?? 0) });
const c = result.contracts;
const { bloom } = await launchBloom({ signer: deployer, artifacts, contracts: c, weth: config.weth, team: config.bloom.team,
  params: { metadataURI: config.bloom.metadataURI ?? '' }, teamBps: config.bloom.teamBps ?? 2000, mineTokenSalt, v2: true });
if (config.bridge?.elysiumRouter) {   // same as scripts/deploy.mjs: the Elysium -> HyperEVM fee bridge
  const a = artifacts['contracts/bridge/BridgeOut.sol'].BridgeOut;
  const out = await new ContractFactory(a.abi, a.evm.bytecode.object, deployer).deploy(config.bridge.elysiumRouter, config.governor, config.bridge.feeRecipient, config.bridge.feeBps);
  await out.waitForDeployment();
  c.BridgeOut = await out.getAddress();
}
let gas = 0n, txs = 0;
const nonce1 = await provider.getTransactionCount(config.deployer);
for (let b = forkBlock + 1; b <= await provider.getBlockNumber(); b++) {
  for (const hash of (await provider.getBlock(b)).transactions) {
    const r = await provider.getTransactionReceipt(hash);
    if (r.from.toLowerCase() === config.deployer.toLowerCase()) { gas += r.gasUsed; txs++; }
  }
}
assert.equal(txs, nonce1 - nonce0);
step('deploy: proxied system + BLOOM + BridgeOut', `${txs} transactions, ${gas.toLocaleString()} gas`);
const factory = at('contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', c.LaunchFactory, deployer);
const bloomToken = at('contracts/LaunchToken.sol', 'LaunchToken', bloom, provider);
assert.ok(bloom.toLowerCase().endsWith('b00b'));
assert.equal(await bloomToken.balanceOf(config.bloom.team), 10n ** 27n * BigInt(config.bloom.teamBps ?? 2000) / 10_000n);
assert.equal(await factory.owner(), config.governor);
assert.equal(await factory.platformRecipient(), c.BloomBuybackBurner);
assert.equal(await at('contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', c.BloomBuybackBurner, provider).treasury(), config.platformRecipient);
assert.equal(await factory.launchFee(), BigInt(config.launchFeeWei));
assert.equal(await factory.minInitialBuy(), BigInt(config.minInitialBuyWei));
for (const label of ['FeeEscrow', 'LaunchFactory', 'LaunchRouter', 'BuybackVestingVault', 'BloomBuybackBurner']) {
  assert.equal(await new Contract(c[label], ['function upgrader() view returns (address)'], provider).upgrader(), config.governor);
}
step('wiring', `BLOOM ${bloom}, ${(config.bloom.teamBps ?? 2000) / 100}% to the team, owner = upgrader = ${config.governor}`);

// 2) A user launches with the minimum first buy (launch is free) and trades on the curve.
const [user, other] = [await provider.getSigner(0), await provider.getSigner(1)];
for (const s of [user, other]) await rpc('hardhat_setBalance', [await s.getAddress(), '0x' + parseEther('1000').toString(16)]);
const router = at('contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', c.LaunchRouter, user);
const me = await user.getAddress();
const p = { name: 'Fork Petal', symbol: 'FORK', metadataURI: '', creatorRecipient: me, creatorBps: 100, holderShareBps: 5000,
  buybackShareBps: 2000, salt: '0x' + '77'.repeat(32), expectedEconomics: await factory.previewEconomics(0, config.weth), tokenSalt: ZeroHash,
  launchProtection: false, protectionExempt: [] };
const [dep, , initHash] = await factory.tokenInitHash(me, p, 0, config.weth);
p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
const token = await factory.predictToken(me, p, 0, config.weth);
const minBuy = await factory.minInitialBuy();
await assert.rejects(router.launch.staticCall(p, 0, config.weth, minBuy - 1n, 0, await deadline(), { value: minBuy - 1n }), 'first buy below the minimum');
await (await router.launch(p, 0, config.weth, minBuy, 0, await deadline(), { value: minBuy })).wait();
const curve = at('contracts/v2/BondingCurveV2.sol', 'BondingCurveV2', (await factory.launches(token)).curve, provider);
const coin = at('contracts/LaunchToken.sol', 'LaunchToken', token, user);
assert.ok(await coin.balanceOf(me) > 0n);
step('launch', `${token}, free + ${formatEther(minBuy)} HYPE first buy; opening market cap ${formatEther((await curve.quoteReserve()) * 10n ** 27n / (await curve.tokenReserve()))} HYPE`);
await (await router.connect(other).buy(token, parseEther('1'), 1, await other.getAddress(), await deadline(), { value: parseEther('1') })).wait();
const held = await coin.balanceOf(me);
await (await coin.approve(c.LaunchRouter, held)).wait();
await (await router.sell(token, held / 2n, 0, me, await deadline(), true)).wait();
step('curve buy and sell');

// 3) Graduation into the real V4 PoolManager, then pool trades through the hook.
const finish = await curve.quoteBuy(10n ** 40n);
await (await router.connect(other).buy(token, finish.grossUsed + parseEther('1'), 0, await other.getAddress(), await deadline(),
  { value: finish.grossUsed + parseEther('1') })).wait();
const launch = await factory.launches(token);
assert.notEqual(launch.poolId, ZeroHash, 'graduated');
assert.equal(await curve.liquidity(), 0n);
assert.equal(await at('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', c.LiquidityLocker, provider).isLocked(launch.poolId), true);
step('graduation', `raised ${formatEther(finish.grossUsed)} HYPE; pool ${launch.poolId.slice(0, 18)}… locked`);
await (await router.connect(other).buy(token, parseEther('2'), 1, await other.getAddress(), await deadline(), { value: parseEther('2') })).wait();
const otherBal = await coin.connect(other).balanceOf(await other.getAddress());
await (await coin.connect(other).approve(c.LaunchRouter, otherBal)).wait();
await (await router.connect(other).sell(token, otherBal / 4n, 0, await other.getAddress(), await deadline(), true)).wait();
step('pool buy and sell through the 0.10% hook');

// 4) Platform revenue: half buys and burns BLOOM (needs BLOOM's 30-minute price average), half to the fee wallet.
await advance(301);   // past BLOOM's 5-minute opening snipe protection (per-wallet cap)
const bloomCurve = (await factory.launches(bloom)).curve;
const bf = await at('contracts/v2/BondingCurveV2.sol', 'BondingCurveV2', bloomCurve, provider).quoteBuy(10n ** 40n);
await (await router.connect(other).buy(bloom, bf.grossUsed + parseEther('1'), 0, await other.getAddress(), await deadline(),
  { value: bf.grossUsed + parseEther('1') })).wait();
assert.notEqual((await factory.launches(bloom)).poolId, ZeroHash, 'BLOOM graduated');
const burner = at('contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', c.BloomBuybackBurner, other);
const escrow = at('contracts/FeeEscrow.sol', 'FeeEscrow', c.FeeEscrow, provider);
const weth = new Contract(config.weth, ['function balanceOf(address) view returns (uint256)'], provider);
const treasuryBefore = await weth.balanceOf(config.platformRecipient);
assert.ok(await escrow.balances(config.weth, c.BloomBuybackBurner) > 0n, 'platform fees escrowed for the burner');
await (await burner.claim(config.weth)).wait();
const toTreasury = await weth.balanceOf(config.platformRecipient) - treasuryBefore;
assert.ok(toTreasury > 0n, 'fee wallet received its half');
// The burn trades on BLOOM's own pool at its 30-minute average price: build some history first.
for (let i = 0; i < 4; i++) { await advance(600); await (await router.connect(other).buy(bloom, parseEther('0.01'), 1, await other.getAddress(), await deadline(), { value: parseEther('0.01') })).wait(); }
await advance(1900);
const pending = await burner.burnPending();
const [, maxInput] = await at('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', c.BloomBurnAdapter, provider).limits(bloom, config.weth, pending);
await (await burner.executeBurn(pending < maxInput ? pending : maxInput, await deadline() - 360n)).wait();
const burned = await burner.totalBurned();
assert.ok(burned > 0n, 'BLOOM bought and burned');
step('platform revenue', `fee wallet got ${formatEther(toTreasury)} WHYPE; BLOOM burned ${formatEther(burned)}`);

const cost = gas * gasPrice;
console.log(`\nDRY RUN PASSED. Real deploy: ${txs} transactions, ${gas.toLocaleString()} gas = ${formatEther(cost)} HYPE at ${Number(gasPrice) / 1e9} gwei.`);
console.log(`Send the deployer at least ${formatEther(cost * 3n / 2n)} HYPE (cost + 50% for gas price moves).`);
await connection.close();
