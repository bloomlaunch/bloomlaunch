// Usage:
//   npm run deploy:mainnet           # Robinhood Chain mainnet: asks for the key (hidden) and a typed DEPLOY
//   DEPLOY_CONFIG=config/deploy.robinhood-testnet.json RPC_URL=... node scripts/deploy.mjs [--execute] [--confirm-mainnet]
//
// Without --execute the script only validates configuration and chain state.
// The signer comes from DEPLOYER_PRIVATE_KEY in the operator's own environment, or a hidden
// prompt (never commit it, never paste it into chat), or from an unlocked RPC account.
import fs from 'node:fs';
import readline from 'node:readline';
import { JsonRpcProvider, NonceManager, Wallet, keccak256 } from 'ethers';
import { deploySystem, validateConfig, launchBloom, CREATE2_PROXY } from './deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

/// Builds the signer without ever printing the key: a malformed key gives a generic error.
function walletFromEnv(key, provider) {
  const clean = key.trim().replace(/^(?!0x)/, '0x');
  if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) throw new Error('DEPLOYER_PRIVATE_KEY is not a 64-hex-character private key (value not shown). Re-run: read -s DEPLOYER_PRIVATE_KEY && export DEPLOYER_PRIVATE_KEY, then paste only the key.');
  return new Wallet(clean, provider);
}

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    if (hidden) rl._writeToOutput = () => {}; // muted after the prompt is drawn: the key is never echoed
  });
}

const MAINNET_CHAIN_ID = 4663n;
const configPath = process.env.DEPLOY_CONFIG;
const rpc = process.env.RPC_URL;
if (!configPath || !rpc) throw new Error('DEPLOY_CONFIG and RPC_URL are required');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
validateConfig(config);
const artifacts = JSON.parse(fs.readFileSync('artifacts/production.json', 'utf8'));
const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const { chainId } = await provider.getNetwork();
if (chainId !== BigInt(config.chainId)) throw new Error(`RPC chain ${chainId} does not match config chain ${config.chainId}`);
const pmCode = await provider.getCode(config.poolManager);
console.log(`chain ${chainId}; PoolManager code ${pmCode.length / 2 - 1} bytes, hash ${keccak256(pmCode)}`);
console.log(`CREATE2 proxy present: ${(await provider.getCode(CREATE2_PROXY)) !== '0x'}`);
if (config.poolManagerCodeHash) console.log(`PoolManager matches reviewed hash: ${keccak256(pmCode) === config.poolManagerCodeHash}`);
const wethCode = await provider.getCode(config.weth);
console.log(`WETH code present: ${wethCode !== '0x'}`);
if (config.deployer) {
  const balance = await provider.getBalance(config.deployer);
  console.log(`deployer ${config.deployer} balance ${Number(balance) / 1e18} ETH (about 28M gas is needed for the system plus BLOOM)`);
}
if (!process.argv.includes('--execute')) {
  console.log('Validation only. Re-run with --execute to deploy.');
  process.exit(0);
}
// Validation above is read-only on any chain; sending transactions to mainnet needs an explicit flag.
const mainnet = chainId === MAINNET_CHAIN_ID;
if (mainnet && !process.argv.includes('--confirm-mainnet')) {
  throw new Error('Robinhood Chain mainnet requires --confirm-mainnet, a reviewed config and a completed security review');
}
const outFile = `deployments/${chainId}.json`;
if (fs.existsSync(outFile) && !process.argv.includes('--redeploy')) {
  throw new Error(`${outFile} already exists: this chain already has a deployment. Pass --redeploy to deploy a second system.`);
}
// Graduation economics of the standard launch configuration, shown before anything is sent.
const lc = config.launchConfig, supply = BigInt(lc.supply), reserved = BigInt(lc.reservedTokens), phantom = BigInt(lc.phantomQuote);
const phantomTokens = reserved * reserved / (supply - 2n * reserved);
const raise = phantom * (supply - reserved) / (reserved + phantomTokens);
const gradCap = (phantom + raise) * supply / (reserved + phantomTokens);
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
const estimate = 30_000_000n * gasPrice;
const eth = v => (Number(v) / 1e18).toFixed(6);
// NonceManager counts nonces locally so back-to-back transactions never reuse one while an RPC lags.
const key = process.env.DEPLOYER_PRIVATE_KEY ?? (process.stdin.isTTY ? await ask('\nPaste the deployer private key (hidden), then Enter: ', true) : null);
const signer = new NonceManager(key ? walletFromEnv(key, provider) : await provider.getSigner());
const signerAddress = await signer.getAddress();
if (config.deployer && signerAddress.toLowerCase() !== config.deployer.toLowerCase()) {
  throw new Error(`that key is for ${signerAddress}, not the configured deployer ${config.deployer}. Nothing was sent.`);
}
const balance = await provider.getBalance(signerAddress);
console.log(`\n================ ${mainnet ? 'ROBINHOOD CHAIN MAINNET' : `chain ${chainId}`} ================`);
console.log(`Deployer        ${signerAddress} (balance ${eth(balance)} ETH)`);
console.log(`Estimated cost  ~${eth(estimate)} ETH (30M gas at ${(Number(gasPrice) / 1e9).toFixed(4)} gwei)`);
console.log(`Governor        ${config.governor}`);
console.log(`Platform fees   0.20% per trade -> BLOOM burner (${(config.bloomBurnBps ?? 0) / 100}% buy-and-burn, rest to treasury ${config.platformRecipient})`);
console.log(`Launch curve    ${Number(supply / 10n ** 18n).toLocaleString()} tokens; graduates after ~${eth(raise)} ETH raised (market cap ~${eth(gradCap)} ETH)`);
if (config.bloom) console.log(`BLOOM           team ${config.bloom.team}: 100M reserve, 50M unlocked at launch, 50M vesting 12 months`);
console.log('Contracts are immutable once deployed.\n');
if (balance < estimate * 2n) throw new Error(`balance is below twice the estimated cost; top up the deployer first. Nothing was sent.`);
if (process.stdin.isTTY && (await ask(`Type DEPLOY to send the transactions, anything else to cancel: `)) !== 'DEPLOY') {
  console.log('Cancelled. Nothing was sent.');
  process.exit(0);
}
fs.mkdirSync('deployments', { recursive: true });
const logFile = `deployments/${chainId}-deploy.log`;
const log = line => { console.log(line); fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); };
const result = await deploySystem({ signer, artifacts, config, log });
// BLOOM must launch before the governor accepts ownership (the deployer is still owner).
if (config.bloom && config.bloomBurnBps != null) {
  const { bloom, vesting } = await launchBloom({ signer, artifacts, contracts: result.contracts, weth: config.weth,
    team: config.bloom.team, params: { metadataURI: config.bloom.metadataURI ?? '' }, mineTokenSalt,
    ...(config.bloom.phantomQuote ? { phantomQuote: BigInt(config.bloom.phantomQuote) } : {}), log });
  Object.assign(result, { bloom, teamVesting: vesting });
}
fs.writeFileSync(outFile, JSON.stringify({ ...result, config, deployedAt: new Date().toISOString() }, null, 2));
console.log(`\nDone. Wrote ${outFile}; deployer balance now ${eth(await provider.getBalance(signerAddress))} ETH.`);
if (config.governor.toLowerCase() !== signerAddress.toLowerCase()) console.log(`Governor ${config.governor} must call acceptOwnership() on the factory.`);
