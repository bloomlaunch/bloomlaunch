// Measures one user launch (minimum first buy) on a fork of Elysium mainnet: gas used and real cost.
import fs from 'node:fs';
import { network } from 'hardhat';
import { BrowserProvider, ZeroHash, formatEther, parseEther } from 'ethers';
import { output } from './compile.mjs';
import { attach } from './deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const d = JSON.parse(fs.readFileSync('config/elysium-mainnet.deployment.json', 'utf8'));
const c = d.contracts, weth = d.config.weth;
const conn = await network.create('elysiumFork');
const provider = new BrowserProvider(conn.provider, undefined, { cacheTimeout: -1 });
const user = await provider.getSigner(0);
await conn.provider.request({ method: 'hardhat_setBalance', params: [await user.getAddress(), '0x' + parseEther('10').toString(16)] });
const factory = attach(output.contracts, 'contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', c.LaunchFactory, user);
const router = attach(output.contracts, 'contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', c.LaunchRouter, user);
const me = await user.getAddress();
const p = { name: 'Gas Check', symbol: 'GAS', metadataURI: 'bloom-meta:' + 'a'.repeat(64), creatorRecipient: me, creatorBps: 200, holderShareBps: 5000,
  buybackShareBps: 0, salt: '0x' + '33'.repeat(32), expectedEconomics: await factory.previewEconomics(0, weth), tokenSalt: ZeroHash,
  launchProtection: true, protectionExempt: [] };
const [dep, , initHash] = await factory.tokenInitHash(me, p, 0, weth);
p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
const minBuy = await factory.minInitialBuy();
const est = await router.launch.estimateGas(p, 0, weth, minBuy, 0, 2n ** 40n, { value: minBuy });
const rc = await (await router.launch(p, 0, weth, minBuy, 0, 2n ** 40n, { value: minBuy })).wait();
const usd = 73.5, base = 500_000_000n;
const hype = wei => Number(formatEther(wei));
console.log(`launch: estimate ${est.toLocaleString()} gas, used ${rc.gasUsed.toLocaleString()} gas`);
console.log(`real cost at Elysium's 0.5 gwei: ${formatEther(rc.gasUsed * base)} HYPE = about USD ${(hype(rc.gasUsed * base) * usd).toFixed(3)}`);
console.log(`if a wallet budgets 1 gwei: ${formatEther(est * 1_000_000_000n)} HYPE = about USD ${(hype(est * 1_000_000_000n) * usd).toFixed(3)} (a maximum, not what is charged)`);
for (const [f, n] of [['contracts/LaunchToken.sol', 'LaunchToken'], ['contracts/v2/BondingCurveV2.sol', 'BondingCurveV2']]) {
  console.log(`${n} code ${output.contracts[f][n].evm.deployedBytecode.object.length / 2} bytes`);
}
await conn.close();
