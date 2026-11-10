// Usage:
//   npm run deploy:mainnet           # Robinhood Chain mainnet: asks for the key (hidden) and a typed DEPLOY
//   DEPLOY_CONFIG=config/deploy.robinhood-testnet.json RPC_URL=... node scripts/deploy.mjs [--execute] [--confirm-mainnet]
//
// Without --execute the script only validates configuration and chain state.
// The signer comes from DEPLOYER_PRIVATE_KEY in the operator's own environment, or a hidden
// prompt (never commit it, never paste it into chat), or from an unlocked RPC account.
import fs from 'node:fs';
import readline from 'node:readline';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, NonceManager, Wallet, keccak256 } from 'ethers';
import { deploySystem, validateConfig, launchBloom, CREATE2_PROXY } from './deploy-lib.mjs';
// config.version 2 deploys BloomLaunch v2 (V3-style curves, launch fee and minimum dev buy in launchFeeWei / minInitialBuyWei).
import { mineTokenSalt } from '../sdk/vanity.mjs';

/// Builds the signer without ever printing the key: a malformed key gives a generic error.
/// A private key, or a recovery phrase: the key is derived in memory and must match `expected` (the
/// standard EVM paths used by MetaMask, Phantom and others, first 10 accounts). Never printed or saved.
function walletFromEnv(key, provider, expected) {
  if (/\s/.test(key.trim())) {
    const phrase = key.trim().toLowerCase().split(/\s+/).join(' ');
    if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('That recovery phrase is not valid (check the words and their order). Nothing was sent.');
    for (let i = 0; i < 10; i++) for (const path of [`m/44'/60'/0'/0/${i}`, `m/44'/60'/${i}'/0/0`]) {
      const w = HDNodeWallet.fromPhrase(phrase, undefined, path);
      if (!expected || w.address.toLowerCase() === expected.toLowerCase()) return w.connect(provider);
    }
    throw new Error(`No account in that recovery phrase matches ${expected}. Nothing was sent.`);
  }
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

// Mainnets need --confirm-mainnet. Elysium pays gas in HYPE.
const MAINNETS = { 4663: 'ROBINHOOD CHAIN MAINNET', 99901: 'ELYSIUM MAINNET' };
const NATIVE = { 99901: 'HYPE', 99801: 'HYPE' };
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
  console.log(`deployer ${config.deployer} balance ${Number(balance) / 1e18} ${NATIVE[chainId] ?? 'ETH'} (about 45M gas is needed for the proxied system plus BLOOM)`);
}
if (!process.argv.includes('--execute')) {
  console.log('Validation only. Re-run with --execute to deploy.');
  process.exit(0);
}
// Validation above is read-only on any chain; sending transactions to mainnet needs an explicit flag.
const mainnet = Boolean(MAINNETS[chainId]);
const unit = NATIVE[chainId] ?? 'ETH';
if (mainnet && !process.argv.includes('--confirm-mainnet')) {
  throw new Error(`${MAINNETS[chainId]} requires --confirm-mainnet and a reviewed config`);
}
const v2 = Number(config.version ?? 1) === 2;
const outFile = `deployments/${chainId}${v2 ? '-v2' : ''}.json`;
if (fs.existsSync(outFile) && !process.argv.includes('--redeploy')) {
  throw new Error(`${outFile} already exists: this chain already has a deployment. Pass --redeploy to deploy a second system.`);
}
// Graduation economics of the standard launch configuration, shown before anything is sent.
const lc = config.launchConfig, supply = BigInt(lc.supply), reserved = BigInt(lc.reservedTokens), phantom = BigInt(lc.phantomQuote);
const phantomTokens = reserved * reserved / (supply - 2n * reserved);
const raise = phantom * (supply - reserved) / (reserved + phantomTokens);
const gradCap = (phantom + raise) * supply / (reserved + phantomTokens);
const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
// v2 behind proxies: ~45M gas (system, proxies, implementations, bindings, BLOOM); v1 measured ~28M.
const GAS = v2 ? 45_000_000n : 30_000_000n;
const estimate = GAS * gasPrice;
const eth = v => (Number(v) / 1e18).toFixed(6);
// NonceManager counts nonces locally so back-to-back transactions never reuse one while an RPC lags.
const key = process.env.DEPLOYER_PRIVATE_KEY ?? (process.stdin.isTTY ? await ask('\nPaste the deployer private key or recovery phrase (hidden), then Enter: ', true) : null);
const signer = new NonceManager(key ? walletFromEnv(key, provider, config.deployer) : await provider.getSigner());
const signerAddress = await signer.getAddress();
if (config.deployer && signerAddress.toLowerCase() !== config.deployer.toLowerCase()) {
  throw new Error(`that key is for ${signerAddress}, not the configured deployer ${config.deployer}. Nothing was sent.`);
}
const balance = await provider.getBalance(signerAddress);
const openCap = phantom * supply / (supply + phantomTokens);
const teamBps = v2 ? Number(config.bloom?.teamBps ?? 2000) : 1000;
console.log(`\n================ ${mainnet ? MAINNETS[chainId] : `chain ${chainId}`} ================`);
console.log(`Deployer        ${signerAddress} (balance ${eth(balance)} ${unit})`);
console.log(`Estimated cost  ~${eth(estimate)} ${unit} (${GAS / 1_000_000n}M gas at ${(Number(gasPrice) / 1e9).toFixed(4)} gwei)`);
console.log(`Owner/governor  ${config.governor}`);
console.log(`Platform fees   ${v2 ? '0.10%' : '0.20%'} per trade -> BLOOM burner (${(config.bloomBurnBps ?? 0) / 100}% buy-and-burn, rest to ${config.platformRecipient})`);
console.log(`Launch curve    ${Number(supply / 10n ** 18n).toLocaleString()} tokens; opens at ~${eth(openCap)} ${unit} market cap; graduates after ~${eth(raise)} ${unit} raised (market cap ~${eth(gradCap)} ${unit})`);
if (config.bloom) console.log(v2 ? `BLOOM           ${teamBps / 100}% of supply to ${config.bloom.team}, unlocked; the rest trades on its curve`
  : `BLOOM           team ${config.bloom.team}: 100M reserve, 50M unlocked at launch, 50M vesting 12 months`);
if (v2) console.log(`Launch terms    launch fee ${eth(BigInt(config.launchFeeWei ?? 0))} ${unit} + minimum first buy ${eth(BigInt(config.minInitialBuyWei ?? 0))} ${unit} per launch`);
console.log(v2 ? 'Core contracts are upgradeable by the owner; launched tokens and curves are immutable.\n' : 'Contracts are immutable once deployed.\n');
// The full v2 deploy measured ~27M gas on testnet (same gas units as mainnet); 30M plus a 25% margin covers it.
if (balance < estimate * 5n / 4n) throw new Error(`balance is below the estimated cost plus a 25% margin; top up the deployer first. Nothing was sent.`);
if (process.stdin.isTTY && (await ask(`Type DEPLOY to send the transactions, anything else to cancel: `)) !== 'DEPLOY') {
  console.log('Cancelled. Nothing was sent.');
  process.exit(0);
}
fs.mkdirSync('deployments', { recursive: true });
const logFile = `deployments/${chainId}-deploy.log`;
const log = line => { console.log(line); fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); };
const startBlock = await provider.getBlockNumber();   // the indexer starts here
const result = await deploySystem({ signer, artifacts, config, log, v2,
  launchFee: BigInt(config.launchFeeWei ?? 0), minInitialBuy: BigInt(config.minInitialBuyWei ?? 0) });
// BLOOM must launch before the governor accepts ownership (the deployer is still owner).
if (config.bloom && config.bloomBurnBps != null) {
  const { bloom, vesting } = await launchBloom({ signer, artifacts, contracts: result.contracts, weth: config.weth,
    team: config.bloom.team, params: { metadataURI: config.bloom.metadataURI ?? '' }, mineTokenSalt,
    ...(config.bloom.phantomQuote ? { phantomQuote: BigInt(config.bloom.phantomQuote) } : {}), teamBps, v2, log });
  Object.assign(result, { bloom, teamVesting: vesting });
}
// Elysium -> HyperEVM bridge with a fee (the HyperEVM side deploys separately: scripts/deploy-bridge-in.mjs).
if (config.bridge?.elysiumRouter) {
  const a = artifacts['contracts/bridge/BridgeOut.sol'].BridgeOut;
  const out = await new ContractFactory(a.abi, a.evm.bytecode.object, signer)
    .deploy(config.bridge.elysiumRouter, config.governor, config.bridge.feeRecipient, config.bridge.feeBps);
  await out.waitForDeployment();
  result.contracts.BridgeOut = await out.getAddress();
  log(`BridgeOut: ${result.contracts.BridgeOut} (${config.bridge.feeBps / 100}% fee to ${config.bridge.feeRecipient})`);
}
fs.writeFileSync(outFile, JSON.stringify({ ...result, startBlock, config, deployedAt: new Date().toISOString() }, null, 2));
console.log(`\nDone. Wrote ${outFile}; deployer balance now ${eth(await provider.getBalance(signerAddress))} ${unit}.`);
if (config.governor.toLowerCase() !== signerAddress.toLowerCase()) console.log(`Governor ${config.governor} must call acceptOwnership() on the factory.`);
