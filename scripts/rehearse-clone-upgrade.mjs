// Rehearses the clone-launch upgrade on a fork of Elysium mainnet at the current block: the factory owner
// is impersonated, nothing is sent to the real chain. Checks that existing state survives, that a new
// launch is a clone and how much gas it uses, and that BLOOM (a full-contract coin) still trades.
// Run with: node scripts/rehearse-clone-upgrade.mjs
import fs from 'node:fs';
import { network } from 'hardhat';
import { BrowserProvider, JsonRpcSigner, ZeroHash, formatEther, parseEther } from 'ethers';
import { output } from './compile.mjs';
import { attach, upgradeToCloneLaunches, upgradeToStandardClones } from './deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const d = JSON.parse(fs.readFileSync('config/elysium-mainnet.deployment.json', 'utf8'));
const c = d.contracts, weth = d.config.weth, owner = d.config.governor;
const art = output.contracts;
const connection = await network.create('elysiumFork');
const rpc = (m, p = []) => connection.provider.request({ method: m, params: p });
const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
provider.pollingInterval = 50;
const check = (ok, label) => { if (!ok) throw new Error(`FAILED: ${label}`); console.log(`  ok  ${label}`); };
await rpc('hardhat_impersonateAccount', [owner]);
const signer = new JsonRpcSigner(provider, owner);
const realBalance = await provider.getBalance(owner);
const factory = attach(art, 'contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', c.LaunchFactory, provider);
const before = { owner: await factory.owner(), deployer: await factory.deployer(), bloom: await factory.platformToken(),
  router: await factory.router(), minBuy: await factory.minInitialBuy(), fee: await factory.launchFee(), configs: await factory.configCount(),
  bloomLaunch: await factory.launches(await factory.platformToken()) };
console.log(`factory owner ${before.owner}, deployer ${before.deployer}`);

const from = await provider.getBlockNumber();
// --standard rehearses the second move (plain EIP-1167 clones that explorers link to the verified masters).
const standard = process.argv.includes('--standard');
const up = standard ? await upgradeToStandardClones({ signer, artifacts: art, contracts: c, log: l => console.log('  ' + l) })
  : await upgradeToCloneLaunches({ signer, artifacts: art, contracts: c, log: l => console.log('  ' + l) });
let gas = 0n, txs = 0;
for (let b = from + 1; b <= await provider.getBlockNumber(); b++) for (const h of (await provider.getBlock(b)).transactions) {
  const r = await provider.getTransactionReceipt(h); if (r.from.toLowerCase() === owner.toLowerCase()) { gas += r.gasUsed; txs++; }
}
check((await factory.deployer()).toLowerCase() === up.LaunchDeployer.toLowerCase(), 'factory uses the clone deployer');
check(await factory.owner() === before.owner && await factory.platformToken() === before.bloom && await factory.router() === before.router
  && await factory.minInitialBuy() === before.minBuy && await factory.launchFee() === before.fee && await factory.configCount() === before.configs,
  'owner, BLOOM, router, launch terms and configs unchanged');
check((await factory.launches(before.bloom)).curve === before.bloomLaunch.curve, 'BLOOM launch record unchanged');

// A user launch with the minimum first buy, exactly as the site does it.
const user = (await provider.getSigner(0));
const me = await user.getAddress();
await rpc('hardhat_setBalance', [me, '0x' + parseEther('100').toString(16)]);
const router = attach(art, 'contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', c.LaunchRouter, user);
const f = factory.connect(user);
const p = { name: 'Clone Check', symbol: 'CLONE', metadataURI: 'bloom-meta:' + 'a'.repeat(64), creatorRecipient: me, creatorBps: 200, holderShareBps: 5000,
  buybackShareBps: 0, salt: '0x' + '44'.repeat(32), expectedEconomics: await f.previewEconomics(0, weth), tokenSalt: ZeroHash,
  launchProtection: true, protectionExempt: [] };
const [dep, , initHash] = await f.tokenInitHash(me, p, 0, weth);
p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
const token = await f.predictToken(me, p, 0, weth);
const minBuy = before.minBuy;
const deadline = BigInt((await provider.getBlock('latest')).timestamp) + 600n;
const est = await router.launch.estimateGas(p, 0, weth, minBuy, 0, deadline, { value: before.fee + minBuy });
const rc = await (await router.launch(p, 0, weth, minBuy, 0, deadline, { value: before.fee + minBuy })).wait();
check(token.toLowerCase().endsWith('b00b'), `launched ${token} (b00b suffix)`);
const code = await provider.getCode(token);
check(code.startsWith('0x363d3d373d3d3d363d73' + up.tokenMaster.slice(2).toLowerCase()), 'token is an EIP-1167 clone of the master');
if (standard) check(code.length === 2 + 45 * 2, 'token is exactly the 45-byte standard clone');
const tc = attach(art, 'contracts/v3/LaunchTokenV3.sol', 'LaunchTokenV3', token, user);
check(await tc.name() === 'Clone Check' && await tc.symbol() === 'CLONE' && await tc.balanceOf(me) > 0n, 'name, symbol, first buy');
const curve = attach(art, 'contracts/v3/BondingCurveV3.sol', 'BondingCurveV3', (await f.launches(token)).curve, user);
check(await curve.factory() === c.LaunchFactory && Number(await curve.phase()) === 1, 'curve trading, reports the factory');

// Trade the new clone, and BLOOM (full-contract coin), after the protection window.
await rpc('evm_increaseTime', [301]); await rpc('evm_mine');
for (const [label, t] of [['clone', token], ['BLOOM', before.bloom]]) {
  const dl = BigInt((await provider.getBlock('latest')).timestamp) + 600n;
  await (await router.buy(t, parseEther('0.01'), 1, me, dl, { value: parseEther('0.01') })).wait();
  const erc = attach(art, 'contracts/LaunchToken.sol', 'LaunchToken', t, user);
  const held = await erc.balanceOf(me);
  await (await erc.approve(c.LaunchRouter, held)).wait();
  await (await router.sell(t, held / 2n, 1, me, dl, true)).wait();
  check(await erc.balanceOf(me) > 0n, `${label}: buy and sell work`);
}

console.log(`\nREHEARSAL PASSED.`);
console.log(`Upgrade: ${txs} transactions, ${gas.toLocaleString()} gas = ${formatEther(gas * 500_000_000n)} HYPE at 0.5 gwei (owner wallet has ${formatEther(realBalance)} HYPE).`);
console.log(`Launch after upgrade: estimate ${est.toLocaleString()}, used ${rc.gasUsed.toLocaleString()} gas = ${formatEther(rc.gasUsed * 500_000_000n)} HYPE at 0.5 gwei (full-contract launches used 4,570,530).`);
await connection.close();
