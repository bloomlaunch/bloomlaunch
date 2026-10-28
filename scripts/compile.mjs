import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Builds:
//   artifacts/compiled.json    BloomLaunch contracts + test fixtures (solc 0.8.38, Cancun)
//   artifacts/production.json  BloomLaunch contracts only, for deployment and verification
//   artifacts/v4core.json      Uniswap V4 PoolManager from @uniswap/v4-core (solc 0.8.26), local tests only
// Cancun is required: Uniswap V4 uses transient storage, so any chain running V4 supports it.
const require = createRequire(import.meta.url);
const digest = text => createHash('sha256').update(text).digest('hex');
function solidityFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? solidityFiles(path.join(directory, entry.name))
      : entry.name.endsWith('.sol') ? [path.join(directory, entry.name)] : []);
}
const dependencyHashes = ['node_modules/@openzeppelin/contracts', 'node_modules/@uniswap/v4-core/src']
  .flatMap(solidityFiles).map(file => [file, digest(fs.readFileSync(file))]);
// v4-core vendors solmate under lib/ (its foundry remapping solmate/=lib/solmate/).
const resolveImport = file => {
  const resolved = file.startsWith('solmate/') ? path.resolve('node_modules/@uniswap/v4-core/lib', file)
    : path.resolve('node_modules', file);
  return fs.existsSync(resolved) ? { contents: fs.readFileSync(resolved, 'utf8') } : { error: `Missing import ${file}` };
};

function build(name, solc, files, settings) {
  const sources = Object.fromEntries(files.map(file =>
    [file.replace(/^node_modules\//, ''), { content: fs.readFileSync(file, 'utf8') }]));
  const input = { language: 'Solidity', sources, settings: { ...settings,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } };
  const hash = digest(JSON.stringify([solc.version(), input, dependencyHashes]));
  const outputFile = `artifacts/${name}.json`, cacheFile = `artifacts/${name}-cache.json`;
  try {
    const metadata = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const bytes = fs.readFileSync(outputFile, 'utf8');
    if (metadata.sourceHash === hash && metadata.outputHash === digest(bytes)) return JSON.parse(bytes);
  } catch { /* Missing or stale cache requires compilation. */ }
  // Record every imported file so the saved standard-JSON input is self-contained (block explorer verification).
  const imported = {};
  const result = JSON.parse(solc.compile(JSON.stringify(input), { import: file => {
    const found = resolveImport(file);
    if (found.contents != null) imported[file] = { content: found.contents };
    return found;
  } }));
  const errors = (result.errors || []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const bytes = JSON.stringify(result.contracts);
  fs.writeFileSync(outputFile, bytes);
  fs.writeFileSync(cacheFile, JSON.stringify({ sourceHash: hash, outputHash: digest(bytes),
    compiler: solc.version(), settings: input.settings, standardJsonInputSha256: digest(JSON.stringify(input)) }, null, 2));
  if (name === 'production') fs.writeFileSync('artifacts/production-input.json', JSON.stringify({ ...input, sources: { ...input.sources, ...imported } }));
  return result.contracts;
}

fs.mkdirSync('artifacts', { recursive: true });
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' };
const solc = require('solc');
const productionFiles = solidityFiles('contracts');
const contracts = build('compiled', solc, [...productionFiles, 'test/Fixtures.sol'], settings);
const production = process.argv.includes('--production')
  ? build('production', solc, productionFiles, settings) : undefined;
// Uniswap's own release settings for v4-core 1.0.2 (foundry.toml), minus the
// unbounded optimizer run count, which only affects runtime gas.
const v4core = build('v4core', require('solc-0826'), ['node_modules/@uniswap/v4-core/src/PoolManager.sol', 'node_modules/@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol'], { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' });
export const output = { contracts, production, v4core };
