// Creates the BloomLaunch governor Safe (v1.4.1 multisig) directly through Safe's canonical proxy
// factory: gas only, no website or subscription. The Safe works in any Safe-compatible app.
//
//   npm run safe:create              # Robinhood Chain mainnet
//   npm run safe:create -- --testnet # Robinhood Chain testnet
//
// Owners default to the deployer, treasury and team wallets from the deploy config, 2 of 3 required
// (override with SAFE_OWNERS=0xA,0xB,0xC and SAFE_THRESHOLD). It asks for the paying wallet's private
// key with hidden input (or reads DEPLOYER_PRIVATE_KEY), shows what it will create, and asks before
// sending. Afterwards it writes the Safe into the config as the governor.
import fs from 'node:fs';
import readline from 'node:readline';
import { Contract, JsonRpcProvider, Wallet, getAddress, keccak256, toUtf8Bytes, ZeroAddress } from 'ethers';

// Canonical Safe v1.4.1 deployments (same address on every chain; present on Robinhood mainnet and testnet).
const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

const testnet = process.argv.includes('--testnet');
const configPath = process.env.DEPLOY_CONFIG ?? (testnet ? 'config/deploy.robinhood-testnet.json' : 'config/deploy.robinhood-mainnet.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const rpc = process.env.RPC_URL ?? (testnet ? 'https://rpc.testnet.chain.robinhood.com' : 'https://rpc.mainnet.chain.robinhood.com');
const owners = (process.env.SAFE_OWNERS ? process.env.SAFE_OWNERS.split(',') : [config.deployer, config.platformRecipient, config.bloom?.team])
  .map(s => s?.trim()).filter(Boolean).map(a => getAddress(a));
const threshold = Number(process.env.SAFE_THRESHOLD ?? 2);
if (new Set(owners).size !== owners.length) throw new Error('duplicate owner');
if (!(threshold >= 1 && threshold <= owners.length)) throw new Error('threshold must be between 1 and the number of owners');

function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, answer => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    // Mute only after the prompt is drawn, so it stays visible while the key is not echoed.
    if (hidden) rl._writeToOutput = () => {};
  });
}
/// Builds the signer without ever printing the key: a malformed key gives a generic error.
function walletFrom(key, provider) {
  const clean = key.trim().replace(/^(?!0x)/, '0x');
  if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) throw new Error('That is not a private key (64 hex characters). Nothing was sent; run it again and paste only the key.');
  return new Wallet(clean, provider);
}

const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const { chainId } = await provider.getNetwork();
if (chainId !== BigInt(config.chainId)) throw new Error(`RPC is chain ${chainId} but ${configPath} is for ${config.chainId}`);
for (const [name, address] of [['Safe singleton', SAFE_L2], ['proxy factory', PROXY_FACTORY], ['fallback handler', FALLBACK_HANDLER]]) {
  if (await provider.getCode(address) === '0x') throw new Error(`${name} is not deployed on chain ${chainId}`);
}
const safeAbi = ['function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
  'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)'];
const initializer = new Contract(SAFE_L2, safeAbi).interface.encodeFunctionData('setup',
  [owners, threshold, ZeroAddress, '0x', FALLBACK_HANDLER, ZeroAddress, 0, ZeroAddress]);
// Deterministic per chain and owner set, so running it twice never creates a second Safe.
const saltNonce = BigInt(keccak256(toUtf8Bytes(`BloomLaunch governor ${chainId} ${owners.join(',')} ${threshold}`)));
const factoryAbi = ['function createProxyWithNonce(address,bytes,uint256) returns (address)'];
const predicted = await new Contract(PROXY_FACTORY, factoryAbi, provider)
  .createProxyWithNonce.staticCall(SAFE_L2, initializer, saltNonce, { from: owners[0] }).catch(() => null);

console.log(`\nRobinhood Chain ${testnet ? 'TESTNET' : 'MAINNET'} (${chainId})`);
console.log(`Owners (${threshold} of ${owners.length} must approve):`);
for (const o of owners) console.log(`  ${o}`);
if (!predicted) {
  console.log('\nThis Safe already exists. Nothing to do.');
  process.exit(0);
}
console.log(`New Safe address: ${predicted}\n`);

const signer = walletFrom(process.env.DEPLOYER_PRIVATE_KEY ?? await ask('Paste the private key of the wallet paying gas (hidden), then Enter: ', true), provider);
const balance = await provider.getBalance(signer.address);
console.log(`Paying from ${signer.address} (balance ${(Number(balance) / 1e18).toFixed(6)} ETH, cost about 0.00001 ETH)`);
if (!/^y(es)?$/i.test(await ask('Create this Safe now? (y/n) '))) { console.log('Cancelled. Nothing was sent.'); process.exit(0); }

const factory = new Contract(PROXY_FACTORY, factoryAbi, signer);
const receipt = await (await factory.createProxyWithNonce(SAFE_L2, initializer, saltNonce)).wait();
const safe = new Contract(predicted, safeAbi, provider);
const [onchainOwners, onchainThreshold, version] = await Promise.all([safe.getOwners(), safe.getThreshold(), safe.VERSION()]);
if (onchainOwners.length !== owners.length || Number(onchainThreshold) !== threshold) throw new Error('Safe setup does not match');
console.log(`\nCreated Safe ${version} at ${predicted}`);
console.log(`Transaction ${receipt.hash}`);
console.log(`Owners verified onchain; ${onchainThreshold} of ${onchainOwners.length} required.`);

// The Safe becomes the governor: the deploy hands factory ownership to it.
config.governor = predicted;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log(`Set it as the governor in ${configPath}.`);
