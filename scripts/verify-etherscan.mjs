// Publishes contract source on Etherscan (robin.etherscan.io) through the v2 API, one contract at a
// time, using a record of addresses, contract names and ABI-encoded constructor arguments.
// Usage: ETHERSCAN_API_KEY=... node scripts/verify-etherscan.mjs [verification/robinhood-mainnet.json]
// Constructor arguments in the record were re-encoded from the deployment and matched onchain.
import fs from 'node:fs';

const record = JSON.parse(fs.readFileSync(process.argv[2] ?? 'verification/robinhood-mainnet.json', 'utf8'));
const key = process.env.ETHERSCAN_API_KEY;
if (!key) throw new Error('ETHERSCAN_API_KEY is required');
const source = fs.readFileSync(record.input, 'utf8');
const API = `https://api.etherscan.io/v2/api?chainid=${record.chainId}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function post(params) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(API, { method: 'POST', body: new URLSearchParams({ apikey: key, chainid: String(record.chainId), ...params }) });
      return await res.json();
    } catch (error) { if (attempt > 4) throw error; await sleep(3000 * attempt); }
  }
}
let failed = 0;
for (const c of record.contracts) {
  const submitted = await post({ module: 'contract', action: 'verifysourcecode', contractaddress: c.address, sourceCode: source,
    codeformat: 'solidity-standard-json-input', contractname: c.contractName, compilerversion: record.compilerVersion,
    constructorArguements: c.constructorArguments });
  let result = String(submitted.result);
  if (submitted.status === '1') {
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      result = String((await post({ module: 'contract', action: 'checkverifystatus', guid: submitted.result })).result);
      if (!/pending|queue/i.test(result)) break;
    }
  }
  const ok = /pass|already verified/i.test(result);
  if (!ok) failed++;
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${c.label.padEnd(28)} ${c.address}  ${result}`);
  await sleep(600);
}
console.log(failed ? `\n${failed} contract(s) not verified` : `\nAll ${record.contracts.length} contracts verified on Etherscan.`);
process.exit(failed ? 1 : 0);
