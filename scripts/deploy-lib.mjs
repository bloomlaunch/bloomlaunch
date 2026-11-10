import { AbiCoder, Contract, ContractFactory, Interface, concat, getCreate2Address, keccak256, isAddress, ZeroAddress } from 'ethers';

// Deterministic deployment proxy (Arachnid), present on most EVM chains at this
// address. Calldata is salt (32 bytes) followed by init code.
export const CREATE2_PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const HOOK_FLAGS = (1n << 13n) | (1n << 7n) | (1n << 6n) | (1n << 3n) | (1n << 2n);
const ALL_HOOK_MASK = (1n << 14n) - 1n;
const coder = AbiCoder.defaultAbiCoder();
const REQUIRED = ['chainId', 'poolManager', 'weth', 'governor', 'platformRecipient', 'launchConfig'];

/// Validates a deployment configuration before any transaction is sent.
export function validateConfig(config) {
  for (const key of REQUIRED) if (config[key] == null) throw new Error(`deployment config missing ${key}`);
  for (const key of ['poolManager', 'weth', 'governor', 'platformRecipient']) {
    if (!isAddress(config[key]) || config[key] === ZeroAddress) throw new Error(`deployment config ${key} is not an address`);
  }
  // Each launch configuration is bound to one quote asset; economics are in that asset's units.
  const list = [{ ...config.launchConfig, quote: config.launchConfig.quote ?? config.weth }, ...(config.extraLaunchConfigs ?? [])];
  return list.map(c => {
    if (!isAddress(c.quote)) throw new Error('launch config quote is not an address');
    const supply = BigInt(c.supply), reserved = BigInt(c.reservedTokens), phantom = BigInt(c.phantomQuote);
    if (supply <= 0n || reserved <= 0n || reserved * 2n >= supply || phantom <= 0n) throw new Error('invalid launch economics');
    return { supply, reservedTokens: reserved, phantomQuote: phantom, quote: c.quote };
  });
}

export function mineHookSalt(deployer, initCode) {
  const initHash = keccak256(initCode);
  for (let i = 0n; i < 1n << 24n; i++) {
    const salt = '0x' + i.toString(16).padStart(64, '0');
    const address = getCreate2Address(deployer, salt, initHash);
    if ((BigInt(address) & ALL_HOOK_MASK) === HOOK_FLAGS) return { salt, address };
  }
  throw new Error('no hook salt found');
}

/// Deploys and wires the complete BloomLaunch contract set from production
/// artifacts. The signer is supplied by the caller; this module never reads keys.
/// Ownership is offered to `config.governor` via Ownable2Step and must be
/// accepted by that account (normally a multisig).
export async function deploySystem({ signer, artifacts, config, v2 = false, launchFee = 0n, minInitialBuy = 0n, cloneLaunches = true, log = () => {} }) {
  // v2: curves present as Uniswap V3-style pools; launches pay a fee and make a minimum dev buy.
  const FACTORY = v2 ? ['contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2'] : ['contracts/LaunchFactory.sol', 'LaunchFactory'];
  const ROUTER = v2 ? ['contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2'] : ['contracts/LaunchRouter.sol', 'LaunchRouter'];
  const economics = validateConfig(config);
  const provider = signer.provider;
  const { chainId } = await provider.getNetwork();
  if (chainId !== BigInt(config.chainId)) throw new Error(`connected to chain ${chainId}, config is for ${config.chainId}`);
  const deployerAddress = await signer.getAddress();
  const pmCode = await provider.getCode(config.poolManager);
  if (pmCode === '0x') throw new Error('no PoolManager code at configured address');
  if (config.poolManagerCodeHash && keccak256(pmCode) !== config.poolManagerCodeHash) {
    throw new Error('PoolManager runtime code hash differs from the reviewed reference');
  }
  if (await provider.getCode(CREATE2_PROXY) === '0x') throw new Error('CREATE2 deployment proxy is not deployed on this chain');
  const art = (file, name) => artifacts[file][name];
  const deployed = {};
  const deploy = async (label, file, name, args) => {
    const { abi, evm } = art(file, name);
    const contract = await new ContractFactory(abi, evm.bytecode.object, signer).deploy(...args);
    await contract.waitForDeployment();
    deployed[label] = await contract.getAddress();
    log(`${label}: ${deployed[label]}`);
    return contract;
  };
  const send = async (label, promise) => { const receipt = await (await promise).wait(); log(`${label}: ${receipt.hash}`); };

  if (v2) return deployProxiedSystem({ signer, artifacts, config, economics, chainId, deployerAddress, launchFee, minInitialBuy, cloneLaunches, log });
  const escrow = await deploy('FeeEscrow', 'contracts/FeeEscrow.sol', 'FeeEscrow', [ZeroAddress]);
  const adapter = await deploy('CanonicalBuybackAdapter', 'contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter',
    [config.poolManager, deployerAddress]);
  const vault = await deploy('BuybackVestingVault', 'contracts/BuybackVestingVault.sol', 'BuybackVestingVault',
    [deployerAddress, deployed.CanonicalBuybackAdapter]);
  const locker = await deploy('LiquidityLocker', 'contracts/v4/LiquidityLocker.sol', 'LiquidityLocker',
    [config.poolManager, deployerAddress]);
  // The deployer is the temporary owner so it can wire configuration, then hands
  // ownership to the governor in the same run.
  // Optional BLOOM buyback-and-burn: the burner becomes the platform fee recipient and
  // forwards (100% - bloomBurnBps) of revenue to the treasury (config.platformRecipient).
  let platformRecipient = config.platformRecipient;
  if (config.bloomBurnBps != null) {
    await deploy('BloomBuybackBurner', 'contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner',
      [deployed.FeeEscrow, config.platformRecipient, config.weth, config.bloomBurnBps, deployerAddress]);
    await deploy('BloomBurnAdapter', 'contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', [config.poolManager, deployerAddress]);
    platformRecipient = deployed.BloomBuybackBurner;
  }
  const factory = await deploy('LaunchFactory', ...FACTORY,
    [deployerAddress, platformRecipient, deployed.FeeEscrow, deployed.BuybackVestingVault, config.poolManager, deployed.LiquidityLocker]);
  const hookArtifact = art('contracts/v4/BloomFeeHook.sol', 'BloomFeeHook');
  const bytecode = hookArtifact.evm.bytecode.object.startsWith('0x') ? hookArtifact.evm.bytecode.object : '0x' + hookArtifact.evm.bytecode.object;
  const initCode = concat([bytecode, coder.encode(['address', 'address'], [config.poolManager, deployed.LaunchFactory])]);
  const { salt, address: hookAddress } = mineHookSalt(CREATE2_PROXY, initCode);
  await send('BloomFeeHook CREATE2', signer.sendTransaction({ to: CREATE2_PROXY, data: concat([salt, initCode]) }));
  if (await provider.getCode(hookAddress) === '0x') throw new Error('hook deployment failed');
  deployed.BloomFeeHook = hookAddress;
  log(`BloomFeeHook: ${hookAddress} (salt ${salt})`);
  await send('locker.bind', locker.bind(deployed.LaunchFactory, hookAddress));
  await send('vault.bindFactory', vault.bindFactory(deployed.LaunchFactory));
  await send('adapter.bindVault', adapter.bindVault(deployed.BuybackVestingVault));
  await deploy('LaunchRouter', ...ROUTER, [deployed.LaunchFactory, config.poolManager, config.weth]);
  await send('factory.bindRouter', factory.bindRouter(deployed.LaunchRouter));
  await deploy('LimitOrderExecutor', 'contracts/LimitOrderExecutor.sol', 'LimitOrderExecutor', [deployed.LaunchRouter]);
  for (const quote of new Set([config.weth, ...(config.extraQuoteAssets ?? []), ...economics.map(e => e.quote)])) {
    await send(`factory.configureQuote ${quote}`, factory.configureQuote(quote, true));
  }
  for (const e of economics) {
    await send(`factory.addConfig ${e.quote}`, factory.addConfig({ ...e, executor: deployed.LiquidityLocker, enabled: true }));
  }
  if (v2 && (launchFee || minInitialBuy)) await send('factory.setLaunchTerms', factory.setLaunchTerms(launchFee, minInitialBuy));
  // Migrations are created by the governor directly, so the governor owns this factory from the start.
  // v1 only: the v1 Migration launches through factory.launch, which v2 replaces with the fee-charging router.
  if (!v2) await deploy('MigrationFactory', 'contracts/migration/MigrationFactory.sol', 'MigrationFactory',
    [config.governor, deployed.LaunchFactory, config.poolManager]);
  if (config.governor.toLowerCase() !== deployerAddress.toLowerCase()) {
    await send('factory.transferOwnership (pending governor acceptance)', factory.transferOwnership(config.governor));
  }
  return { version: v2 ? 2 : 1, chainId: Number(chainId), deployer: deployerAddress, hookSalt: salt, contracts: deployed,
    pendingOwner: config.governor, block: await provider.getBlockNumber() };
}

/// v2 (Elysium): the core contracts run behind ERC-1967 (UUPS) proxies, except the liquidity locker and the
/// V4 fee hook, which are deployed directly and can never change (locked liquidity stays locked; pool
/// fees stay fixed). Order of work:
///   1. a ProxyBootstrap implementation, then one proxy per upgradeable contract pointing at it, so every
///      address is known; the locker directly; the hook by CREATE2 at an address with the V4 permission bits;
///   2. each real implementation, with those proxy addresses as constructor immutables, installed with
///      upgradeToAndCall (the router before the limit-order executor, whose constructor reads it);
///   3. the same one-time bindings and configuration as v1, on the proxy addresses.
/// Upgrade rights then follow the factory owner. Tokens, curves, the locker and the hook are never proxied.
async function deployProxiedSystem({ signer, artifacts, config, economics, chainId, deployerAddress, launchFee, minInitialBuy, cloneLaunches, log }) {
  const provider = signer.provider;
  const art = (file, name) => artifacts[file][name];
  const bytecodeOf = a => (a.evm.bytecode.object.startsWith('0x') ? '' : '0x') + a.evm.bytecode.object;
  const contracts = {}, implementations = {};
  const send = async (label, promise) => { const receipt = await (await promise).wait(); log(`${label}: ${receipt.hash}`); return receipt; };
  const create = async (file, name, args) => {
    const a = art(file, name);
    const c = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const PROXY = ['contracts/proxy/ProxyBootstrap.sol', 'CoreProxy'];
  // ERC-1967 proxies must be created with an initialization call: the placeholder's no-op initialize().
  const BOOTSTRAP_INIT = new Interface(['function initialize()']).encodeFunctionData('initialize');
  const bootstrap = await create('contracts/proxy/ProxyBootstrap.sol', 'ProxyBootstrap', [deployerAddress]);
  const bootstrapAddress = await bootstrap.getAddress();
  log(`ProxyBootstrap: ${bootstrapAddress}`);
  const proxy = async label => {
    const c = await create(...PROXY, [bootstrapAddress, BOOTSTRAP_INIT]);
    contracts[label] = await c.getAddress();
    log(`${label} proxy: ${contracts[label]}`);
  };
  const withBurn = config.bloomBurnBps != null;
  for (const label of ['FeeEscrow', 'CanonicalBuybackAdapter', 'BuybackVestingVault',
    ...(withBurn ? ['BloomBuybackBurner', 'BloomBurnAdapter'] : []), 'LaunchFactory', 'LaunchRouter', 'LimitOrderExecutor']) await proxy(label);
  // Immutable: the locker (holds every graduated pool's liquidity) and the hook (charges pool fees).
  const lockerDirect = await create('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', [config.poolManager, deployerAddress]);
  contracts.LiquidityLocker = await lockerDirect.getAddress();
  log(`LiquidityLocker (immutable): ${contracts.LiquidityLocker}`);
  // The PoolManager reads a hook's permissions from its address bits.
  const hookInit = concat([bytecodeOf(art('contracts/v4/BloomFeeHook.sol', 'BloomFeeHook')),
    coder.encode(['address', 'address'], [config.poolManager, contracts.LaunchFactory])]);
  const { salt, address: hookAddress } = mineHookSalt(CREATE2_PROXY, hookInit);
  await send('BloomFeeHook CREATE2', signer.sendTransaction({ to: CREATE2_PROXY, data: concat([salt, hookInit]) }));
  if (await provider.getCode(hookAddress) === '0x') throw new Error('hook deployment failed');
  contracts.BloomFeeHook = hookAddress;
  log(`BloomFeeHook (immutable): ${hookAddress} (salt ${salt})`);

  const install = async (label, file, name, args, initData = '0x') => {
    const impl = await create(file, name, args);
    implementations[label] = await impl.getAddress();
    await send(`${label} -> implementation ${implementations[label]}`,
      attach(artifacts, 'contracts/proxy/ProxyBootstrap.sol', 'ProxyBootstrap', contracts[label], signer).upgradeToAndCall(implementations[label], initData));
    return attach(artifacts, file, name, contracts[label], signer);
  };
  const platformRecipient = withBurn ? contracts.BloomBuybackBurner : config.platformRecipient;
  await install('FeeEscrow', 'contracts/FeeEscrow.sol', 'FeeEscrow', [contracts.LaunchFactory]);
  const adapter = await install('CanonicalBuybackAdapter', 'contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', [config.poolManager, deployerAddress]);
  const vault = await install('BuybackVestingVault', 'contracts/BuybackVestingVault.sol', 'BuybackVestingVault', [deployerAddress, contracts.CanonicalBuybackAdapter]);
  const locker = lockerDirect;
  if (withBurn) {
    await install('BloomBuybackBurner', 'contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner',
      [contracts.FeeEscrow, config.platformRecipient, config.weth, config.bloomBurnBps, deployerAddress]);
    await install('BloomBurnAdapter', 'contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', [config.poolManager, deployerAddress]);
  }
  // v3 deployer: each launch clones fixed master contracts (about a fifth of the gas); v2 deploys them in full.
  const launchDeployer = cloneLaunches
    ? await create('contracts/v3/LaunchDeployerV3.sol', 'LaunchDeployerV3', [contracts.LaunchFactory])
    : await create('contracts/v2/LaunchDeployerV2.sol', 'LaunchDeployerV2', [contracts.LaunchFactory]);
  contracts.LaunchDeployer = await launchDeployer.getAddress();
  log(`LaunchDeployer: ${contracts.LaunchDeployer}`);
  const factoryIface = new Interface(art('contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2').abi);
  const factory = await install('LaunchFactory', 'contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2',
    [platformRecipient, contracts.FeeEscrow, contracts.BuybackVestingVault, config.poolManager, contracts.LiquidityLocker],
    factoryIface.encodeFunctionData('initialize', [deployerAddress, contracts.LaunchDeployer]));
  await install('LaunchRouter', 'contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', [contracts.LaunchFactory, config.poolManager, config.weth]);
  await install('LimitOrderExecutor', 'contracts/LimitOrderExecutor.sol', 'LimitOrderExecutor', [contracts.LaunchRouter]);

  await send('locker.bind', locker.bind(contracts.LaunchFactory, hookAddress));
  await send('vault.bindFactory', vault.bindFactory(contracts.LaunchFactory));
  await send('adapter.bindVault', adapter.bindVault(contracts.BuybackVestingVault));
  await send('factory.bindRouter', factory.bindRouter(contracts.LaunchRouter));
  for (const quote of new Set([config.weth, ...(config.extraQuoteAssets ?? []), ...economics.map(e => e.quote)])) {
    await send(`factory.configureQuote ${quote}`, factory.configureQuote(quote, true));
  }
  for (const e of economics) await send(`factory.addConfig ${e.quote}`, factory.addConfig({ ...e, executor: contracts.LiquidityLocker, enabled: true }));
  if (launchFee || minInitialBuy) await send('factory.setLaunchTerms', factory.setLaunchTerms(launchFee, minInitialBuy));
  if (config.governor.toLowerCase() !== deployerAddress.toLowerCase()) {
    await send('factory.transferOwnership (pending governor acceptance)', factory.transferOwnership(config.governor));
  }
  return { version: 2, proxied: true, chainId: Number(chainId), deployer: deployerAddress, hookSalt: salt, contracts, implementations,
    proxyBootstrap: bootstrapAddress, pendingOwner: config.governor, block: await provider.getBlockNumber() };
}

/// Moves an existing proxied factory to clone launches: deploys LaunchDeployerV3 (which creates the two fixed
/// master contracts) and a new factory implementation with the same immutables, then upgradeToAndCall with
/// initializeV2(deployer). Signed by the factory owner. Idempotent: resumes after a partial run.
/// Launched tokens and curves, BLOOM, the locker and the hook are untouched.
export async function upgradeToCloneLaunches({ signer, artifacts, contracts, reader, existing = {}, onStep = () => {}, log = () => {} }) {
  const provider = reader ?? signer.provider;
  const read = async fn => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 9) throw e; await new Promise(r => setTimeout(r, 1500)); } } };
  const send = async (label, promise) => { const receipt = await (await promise).wait(); log(`${label}: ${receipt.hash}`); await new Promise(r => setTimeout(r, 2000)); return receipt; };
  const FACTORY = ['contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2'];
  const DEPLOYER = ['contracts/v3/LaunchDeployerV3.sol', 'LaunchDeployerV3'];
  const factoryView = attach(artifacts, ...FACTORY, contracts.LaunchFactory, provider);
  const me = (await signer.getAddress()).toLowerCase();
  if ((await read(() => factoryView.owner())).toLowerCase() !== me) throw new Error('only the factory owner can upgrade it; nothing sent');
  const isV3 = async address => { try { await attach(artifacts, ...DEPLOYER, address, provider).curveMaster(); return true; } catch { return false; } };
  const current = await read(() => factoryView.deployer());
  if (await isV3(current)) {
    const live = attach(artifacts, ...DEPLOYER, current, provider);
    log(`already on clone launches: deployer ${current}`);
    return { LaunchDeployer: current, curveMaster: await read(() => live.curveMaster()), tokenMaster: await read(() => live.tokenMaster()), done: true };
  }
  const create = async ([file, name], args) => {
    const a = artifacts[file][name];
    const c = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(...args);
    await c.waitForDeployment();
    return c.getAddress();
  };
  let deployerAddress = existing.LaunchDeployer;
  if (!deployerAddress || !(await isV3(deployerAddress))) {
    deployerAddress = await create(DEPLOYER, [contracts.LaunchFactory]);
    log(`LaunchDeployerV3: ${deployerAddress}`);
    await onStep({ LaunchDeployer: deployerAddress });
  } else log(`LaunchDeployerV3: reusing ${deployerAddress}`);
  const dep = attach(artifacts, ...DEPLOYER, deployerAddress, provider);
  const masters = { curveMaster: await read(() => dep.curveMaster()), tokenMaster: await read(() => dep.tokenMaster()) };
  log(`masters: curve ${masters.curveMaster}, token ${masters.tokenMaster}`);
  const args = [await read(() => factoryView.platformRecipient()), await read(() => factoryView.escrow()),
    await read(() => factoryView.buybackVault()), await read(() => factoryView.poolManager()), await read(() => factoryView.locker())];
  const implementation = existing.LaunchFactoryImplementation ?? await create(FACTORY, args);
  log(`LaunchFactory implementation: ${implementation}`);
  await onStep({ LaunchDeployer: deployerAddress, LaunchFactoryImplementation: implementation });
  const iface = new Interface(artifacts[FACTORY[0]][FACTORY[1]].abi);
  await send('LaunchFactory upgradeToAndCall(initializeV2)', attach(artifacts, ...FACTORY, contracts.LaunchFactory, signer)
    .upgradeToAndCall(implementation, iface.encodeFunctionData('initializeV2', [deployerAddress])));
  const now = await read(() => factoryView.deployer());
  if (now.toLowerCase() !== deployerAddress.toLowerCase()) throw new Error(`upgrade not visible yet: deployer ${now}`);
  return { LaunchDeployer: deployerAddress, LaunchFactoryImplementation: implementation, factoryArgs: args, ...masters, done: true };
}

export function attach(artifacts, file, name, address, runner) {
  return new Contract(address, artifacts[file][name].abi, runner);
}

/// Launches BLOOM, the platform token, once: 90% of supply trades on its own bonding curve
/// like any launch (graduating to a locked V4 pool, ...b00b address), and 10% is minted to a
/// team vesting contract: half unlocked at launch, half linear over 12 months. Then binds the buyback-and-burn contract.
/// The signer must still be the factory owner and the deployment bootstrapper (run it right
/// after deploySystem, before the governor accepts ownership).
export async function launchBloom({ signer, artifacts, contracts, weth, team, poolManagerLocker, params = {}, v2 = false, reader,
  vestingSeconds = 365n * 86400n, immediateBps = 5000n, phantomQuote = 126n * 10n ** 16n, teamBps = 2000, mineTokenSalt, log = () => {} }) {
  const factory = v2 ? attach(artifacts, 'contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', contracts.LaunchFactory, signer)
    : attach(artifacts, 'contracts/LaunchFactory.sol', 'LaunchFactory', contracts.LaunchFactory, signer);
  const creator = await signer.getAddress();
  const provider = reader ?? signer.provider;
  // Reads through `reader` when given (a reliable RPC, retried); the signer only signs.
  const fv = reader ? factory.connect(reader) : factory;
  const read = async fn => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 9) throw e; await new Promise(r => setTimeout(r, 1500)); } } };
  // v1: 10% to a vesting contract (half unlocked, half over 12 months). v2 (Elysium): `teamBps` of supply
  // straight to the team wallet, unlocked, and no vesting contract.
  const TOTAL = 10n ** 27n;
  const share = v2 ? BigInt(teamBps) : 1000n;
  let vesting = team ?? creator;
  if (!v2) {
    const start = BigInt((await provider.getBlock('latest')).timestamp);
    const vArt = artifacts['contracts/TeamVesting.sol'].TeamVesting;
    const v = await new ContractFactory(vArt.abi, vArt.evm.bytecode.object, signer).deploy(team ?? creator, start, vestingSeconds, immediateBps);
    await v.waitForDeployment();
    vesting = await v.getAddress();
    log(`TeamVesting: ${vesting}`);
  }
  // Same price curve as standard launches, scaled to the share that trades.
  const tradeSupply = TOTAL * (10_000n - share) / 10_000n;
  const standard = await read(() => fv.configs(0));
  const phantom = v2 ? BigInt(standard.phantomQuote) * (10_000n - share) / 10_000n : phantomQuote;
  const configId = Number(await read(() => fv.configCount()));
  await (await factory.addConfig({ supply: tradeSupply, reservedTokens: tradeSupply / 5n, phantomQuote: phantom,
    quote: weth, executor: poolManagerLocker ?? contracts.LiquidityLocker, enabled: false })).wait(); if (reader) await new Promise(r => setTimeout(r, 2000));
  await (await factory.setConfigEnabled(configId, true)).wait(); if (reader) await new Promise(r => setTimeout(r, 2000));
  const reserve = TOTAL - tradeSupply;
  const p = { name: 'Bloom', symbol: 'BLOOM', metadataURI: '', creatorRecipient: team ?? creator, creatorBps: 0, holderShareBps: 0,
    buybackShareBps: 0, salt: '0x' + 'b1'.repeat(32), launchProtection: true, protectionExempt: [], ...params,
    expectedEconomics: await read(async () => { const e = await fv.previewEconomics(configId, weth); return e; }), tokenSalt: '0x' + '00'.repeat(32) };
  // The new config must be visible to the reader before the address is derived from it.
  for (let i = 0; i < 20 && Number(await read(() => fv.configCount())) <= configId; i++) await new Promise(r => setTimeout(r, 1000));
  const [dep, , initHash] = await read(() => fv.reserveTokenInitHash(creator, p, configId, weth, vesting, reserve));
  p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
  const bloom = getCreate2Address(dep, p.tokenSalt, initHash);
  await (await factory.launchPlatformToken(p, configId, weth, vesting, reserve)).wait(); if (reader) await new Promise(r => setTimeout(r, 2000));
  // Later standard launches must not reuse the BLOOM-sized configuration.
  await (await factory.setConfigEnabled(configId, false)).wait(); if (reader) await new Promise(r => setTimeout(r, 2000));
  log(`BLOOM: ${bloom}`);
  const burner = attach(artifacts, 'contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', contracts.BloomBuybackBurner, signer);
  const adapter = attach(artifacts, 'contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', contracts.BloomBurnAdapter, signer);
  await (await burner.bind(contracts.LaunchFactory, bloom, contracts.BloomBurnAdapter)).wait(); if (reader) await new Promise(r => setTimeout(r, 2000));
  await (await adapter.bindVault(contracts.BloomBuybackBurner)).wait(); if (reader) await new Promise(r => setTimeout(r, 2000));
  log('burner and burn adapter bound to BLOOM');
  return { bloom, vesting: v2 ? null : vesting, team: v2 ? (team ?? creator) : undefined, teamShareBps: Number(share) };
}


/// Deploys the complete BloomLaunch v2 system (see deploySystem with v2: true).
export const deploySystemV2 = options => deploySystem({ ...options, v2: true });

/// Finishes a v2 (proxied) deployment that stopped partway, using the contracts already deployed.
/// Every step checks the chain first and is skipped if already done, so it can be run again safely.
/// Waits for the signer's node to see each prerequisite (wallet RPCs can lag a block behind).
export async function finishProxiedSystem({ signer, artifacts, config, contracts, implementations = {}, launchFee = 0n, minInitialBuy = 0n,
  reader, log = () => {} }) {
  // Reads go through `reader` (a reliable RPC), with retries; the wallet only signs. Wallet RPCs can
  // lag or return empty data right after a transaction.
  const provider = reader ?? signer.provider;
  const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const at = (file, name, address) => attach(artifacts, file, name, address, signer);
  const view = (file, name, address) => attach(artifacts, file, name, address, provider);
  const read = async fn => { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 9) throw e; await new Promise(r => setTimeout(r, 1500)); } } };
  // Pause after each confirmation so the wallet's own node sees it before estimating the next transaction.
  const send = async (label, promise) => { const receipt = await (await promise).wait(); log(`${label}: ${receipt.hash}`); await new Promise(r => setTimeout(r, 2000)); return receipt; };
  const until = async (label, check) => {
    for (let i = 0; i < 30; i++) { try { if (await check()) return; } catch { /* not visible yet */ } await new Promise(r => setTimeout(r, 1000)); }
    throw new Error(`timed out waiting for ${label}`);
  };
  const implOf = async address => '0x' + (await provider.getStorage(address, IMPL_SLOT)).slice(26).toLowerCase();
  const economics = validateConfig(config);
  const deployerAddress = await signer.getAddress();
  const factory = at('contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', contracts.LaunchFactory);
  const router = view('contracts/v2/LaunchRouterV2.sol', 'LaunchRouterV2', contracts.LaunchRouter);
  const factoryView = view('contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', contracts.LaunchFactory);

  // Limit-order executor: its constructor reads router.factory(), so the router must be visible first.
  const bootstrap = contracts.ProxyBootstrap?.toLowerCase();
  if (!bootstrap || await read(() => implOf(contracts.LimitOrderExecutor)) === bootstrap) {
    await until('the router upgrade', async () => (await router.factory()).toLowerCase() === contracts.LaunchFactory.toLowerCase());
    const a = artifacts['contracts/LimitOrderExecutor.sol'].LimitOrderExecutor;
    const impl = await new ContractFactory(a.abi, a.evm.bytecode.object, signer).deploy(contracts.LaunchRouter);
    await impl.waitForDeployment();
    implementations.LimitOrderExecutor = await impl.getAddress();
    await send(`LimitOrderExecutor -> implementation ${implementations.LimitOrderExecutor}`,
      at('contracts/proxy/ProxyBootstrap.sol', 'ProxyBootstrap', contracts.LimitOrderExecutor).upgradeToAndCall(implementations.LimitOrderExecutor, '0x'));
  } else log('LimitOrderExecutor: already installed');

  const locker = at('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', contracts.LiquidityLocker);
  const vault = at('contracts/BuybackVestingVault.sol', 'BuybackVestingVault', contracts.BuybackVestingVault);
  const adapter = at('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', contracts.CanonicalBuybackAdapter);
  const lockerView = view('contracts/v4/LiquidityLocker.sol', 'LiquidityLocker', contracts.LiquidityLocker);
  const vaultView = view('contracts/BuybackVestingVault.sol', 'BuybackVestingVault', contracts.BuybackVestingVault);
  const adapterView = view('contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', contracts.CanonicalBuybackAdapter);
  if (await read(() => lockerView.factory()) === ZeroAddress) await send('locker.bind', locker.bind(contracts.LaunchFactory, contracts.BloomFeeHook)); else log('locker: already bound');
  if (await read(() => vaultView.factory()) === ZeroAddress) await send('vault.bindFactory', vault.bindFactory(contracts.LaunchFactory)); else log('vault: already bound');
  await until('the vault binding', async () => (await vaultView.factory()) !== ZeroAddress);
  if (await read(() => adapterView.vault()) === ZeroAddress) await send('adapter.bindVault', adapter.bindVault(contracts.BuybackVestingVault)); else log('adapter: already bound');
  if (await read(() => factoryView.router()) === ZeroAddress) await send('factory.bindRouter', factory.bindRouter(contracts.LaunchRouter)); else log('router: already bound');
  for (const quote of new Set([config.weth, ...(config.extraQuoteAssets ?? []), ...economics.map(e => e.quote)])) {
    if (!(await read(() => factoryView.quoteAssets(quote))).approved) await send(`factory.configureQuote ${quote}`, factory.configureQuote(quote, true));
    else log(`quote ${quote}: already approved`);
  }
  await until('the quote approval', async () => (await factoryView.quoteAssets(config.weth)).approved);
  if (Number(await read(() => factoryView.configCount())) === 0) {
    for (const e of economics) await send(`factory.addConfig ${e.quote}`, factory.addConfig({ ...e, executor: contracts.LiquidityLocker, enabled: true }));
  } else log('launch configuration: already added');
  if ((launchFee || minInitialBuy) && (await read(() => factoryView.launchFee()) !== launchFee || await read(() => factoryView.minInitialBuy()) !== minInitialBuy)) {
    await send('factory.setLaunchTerms', factory.setLaunchTerms(launchFee, minInitialBuy));
  } else log('launch terms: already set');
  await until('the launch configuration', async () => Number(await factoryView.configCount()) > 0);
  return { version: 2, proxied: true, chainId: Number(config.chainId), deployer: deployerAddress, contracts, implementations,
    proxyBootstrap: contracts.ProxyBootstrap, pendingOwner: config.governor, block: await provider.getBlockNumber() };
}
