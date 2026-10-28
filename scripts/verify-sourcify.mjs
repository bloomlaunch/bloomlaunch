// Publishes the source of every deployed BloomLaunch contract on Sourcify (free, no API key), which
// recompiles it from the exact standard-JSON input used for the deployment and checks the bytecode.
// Usage: node scripts/verify-sourcify.mjs [deployments/4663.json]
import fs from 'node:fs';
import { JsonRpcProvider } from 'ethers';
import { attach } from './deploy-lib.mjs';

const SOURCIFY = 'https://sourcify.dev/server';
const file = process.argv[2] ?? 'deployments/4663.json';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const artifacts = JSON.parse(fs.readFileSync('artifacts/production.json', 'utf8'));
const stdJsonInput = JSON.parse(fs.readFileSync('artifacts/production-input.json', 'utf8'));
// Exact compiler of the deployed build, e.g. 0.8.38+commit.1835d247 (solc-js adds a platform suffix).
const compilerVersion = JSON.parse(fs.readFileSync('artifacts/production-cache.json', 'utf8')).compiler.replace(/\.Emscripten\.clang$/, '');
const rpc = { 4663: 'https://rpc.mainnet.chain.robinhood.com', 46630: 'https://rpc.testnet.chain.robinhood.com' }[d.chainId];
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const c = d.contracts;
const factory = attach(artifacts, 'contracts/LaunchFactory.sol', 'LaunchFactory', c.LaunchFactory, provider);
const bloomCurve = d.bloom ? (await factory.launches(d.bloom)).curve : null;

const targets = [
  ['FeeEscrow', c.FeeEscrow, 'contracts/FeeEscrow.sol:FeeEscrow'],
  ['CanonicalBuybackAdapter', c.CanonicalBuybackAdapter, 'contracts/v4/CanonicalBuybackAdapter.sol:CanonicalBuybackAdapter'],
  ['BuybackVestingVault', c.BuybackVestingVault, 'contracts/BuybackVestingVault.sol:BuybackVestingVault'],
  ['LiquidityLocker', c.LiquidityLocker, 'contracts/v4/LiquidityLocker.sol:LiquidityLocker'],
  ['BloomBuybackBurner', c.BloomBuybackBurner, 'contracts/BloomBuybackBurner.sol:BloomBuybackBurner'],
  ['BloomBurnAdapter', c.BloomBurnAdapter, 'contracts/v4/CanonicalBuybackAdapter.sol:CanonicalBuybackAdapter'],
  ['LaunchFactory', c.LaunchFactory, 'contracts/LaunchFactory.sol:LaunchFactory'],
  ['LaunchDeployer', await factory.deployer(), 'contracts/LaunchDeployer.sol:LaunchDeployer'],
  ['BloomFeeHook', c.BloomFeeHook, 'contracts/v4/BloomFeeHook.sol:BloomFeeHook'],
  ['LaunchRouter', c.LaunchRouter, 'contracts/LaunchRouter.sol:LaunchRouter'],
  ['LimitOrderExecutor', c.LimitOrderExecutor, 'contracts/LimitOrderExecutor.sol:LimitOrderExecutor'],
  ['MigrationFactory', c.MigrationFactory, 'contracts/migration/MigrationFactory.sol:MigrationFactory'],
  ...(d.teamVesting ? [['TeamVesting', d.teamVesting, 'contracts/TeamVesting.sol:TeamVesting']] : []),
  ...(d.bloom ? [['BLOOM (LaunchToken)', d.bloom, 'contracts/LaunchToken.sol:LaunchToken'],
    ['BLOOM curve (BondingCurve)', bloomCurve, 'contracts/BondingCurve.sol:BondingCurve']] : []),
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
/// fetch with retries: flaky connections should not abort a long verification run.
async function fetch(url, options) {
  for (let attempt = 1; ; attempt++) {
    try { return await globalThis.fetch(url, options); }
    catch (error) { if (attempt >= 5) throw error; await sleep(3000 * attempt); }
  }
}
async function status(address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${d.chainId}/${address}`);
  return res.ok ? (await res.json()).match ?? null : null;
}
let failed = 0;
for (const [label, address, contractIdentifier] of targets) {
  const existing = await status(address);
  if (existing) { console.log(`already verified  ${label.padEnd(26)} ${address} (${existing})`); continue; }
  const res = await fetch(`${SOURCIFY}/v2/verify/${d.chainId}/${address}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stdJsonInput, compilerVersion, contractIdentifier }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.verificationId) { failed++; console.log(`FAILED to submit ${label}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`); continue; }
  let job;
  for (let i = 0; i < 90; i++) {
    await sleep(4000);
    job = await (await fetch(`${SOURCIFY}/v2/verify/${body.verificationId}`)).json();
    if (job.isJobCompleted) break;
  }
  const match = job?.contract?.match;
  if (match) console.log(`verified          ${label.padEnd(26)} ${address} (${match})`);
  else { failed++; console.log(`FAILED            ${label}: ${JSON.stringify(job?.error ?? job).slice(0, 400)}`); }
}
console.log(failed ? `\n${failed} contract(s) not verified` : `\nAll ${targets.length} contracts verified on Sourcify (chain ${d.chainId}).`);
process.exit(failed ? 1 : 0);
