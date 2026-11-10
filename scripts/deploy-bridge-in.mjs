// Deploys BridgeIn (HyperEVM -> Elysium, 0.1% fee) on HyperEVM from the Elysium config's `bridge` section.
// Usage: npm run deploy:bridge-in   (asks for the deployer key or recovery phrase, hidden, then DEPLOY)
import fs from 'node:fs';
import readline from 'node:readline';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet, formatEther } from 'ethers';

const config = JSON.parse(fs.readFileSync(process.argv[2] ?? 'config/deploy.elysium-mainnet.json', 'utf8'));
const b = config.bridge, h = b.hyperevm;
const provider = new JsonRpcProvider(h.rpcUrl, undefined, { staticNetwork: true });
if (Number((await provider.getNetwork()).chainId) !== h.chainId) throw new Error(`RPC is not chain ${h.chainId}`);
for (const [n, a] of [['Inbox', h.inbox], ['gateway router', h.router]]) if ((await provider.getCode(a)) === '0x') throw new Error(`no ${n} at ${a}`);
const ask = (q, hidden = false) => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false; rl._writeToOutput = t => { if (!muted) rl.output.write(t); };
  rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); }); muted = hidden;
});
const secret = process.env.DEPLOYER_PRIVATE_KEY ?? await ask('Deployer private key or recovery phrase (hidden): ', true);
let signer;
if (/\s/.test(secret)) {
  const phrase = secret.toLowerCase().split(/\s+/).join(' ');
  if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('invalid recovery phrase; nothing sent');
  for (let i = 0; i < 10 && !signer; i++) for (const path of [`m/44'/60'/0'/0/${i}`, `m/44'/60'/${i}'/0/0`]) {
    const w = HDNodeWallet.fromPhrase(phrase, undefined, path);
    if (w.address.toLowerCase() === config.deployer.toLowerCase()) { signer = w.connect(provider); break; }
  }
  if (!signer) throw new Error(`no account in that phrase matches ${config.deployer}; nothing sent`);
} else signer = new Wallet(secret, provider);
if (signer.address.toLowerCase() !== config.deployer.toLowerCase()) throw new Error(`key is for ${signer.address}, not ${config.deployer}; nothing sent`);
console.log(`HyperEVM  deployer ${signer.address}  balance ${formatEther(await provider.getBalance(signer.address))} HYPE`);
console.log(`BridgeIn  inbox ${h.inbox}  router ${h.router}  fee ${b.feeBps / 100}% to ${b.feeRecipient}  owner ${config.governor}`);
if ((await ask('Type DEPLOY to deploy on HyperEVM: ')) !== 'DEPLOY') { console.log('Cancelled. Nothing sent.'); process.exit(0); }
const artifacts = JSON.parse(fs.readFileSync('artifacts/production.json', 'utf8'));
const a = artifacts['contracts/bridge/BridgeIn.sol'].BridgeIn;
const c = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(h.inbox, h.router, config.governor, b.feeRecipient, b.feeBps);
await c.waitForDeployment();
const address = await c.getAddress();
fs.mkdirSync('deployments', { recursive: true });
fs.writeFileSync(`deployments/${h.chainId}-bridge-in.json`, JSON.stringify({ chainId: h.chainId, BridgeIn: address, ...b, deployedAt: new Date().toISOString() }, null, 2) + '\n');
console.log(`BridgeIn: ${address}\nWrote deployments/${h.chainId}-bridge-in.json`);
