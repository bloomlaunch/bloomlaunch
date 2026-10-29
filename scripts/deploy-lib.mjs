import { AbiCoder, Contract, ContractFactory, concat, getCreate2Address, keccak256, isAddress, ZeroAddress } from 'ethers';

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
export async function deploySystem({ signer, artifacts, config, v2 = false, launchFee = 0n, minInitialBuy = 0n, log = () => {} }) {
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

  const escrow = await deploy('FeeEscrow', 'contracts/FeeEscrow.sol', 'FeeEscrow', []);
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

export function attach(artifacts, file, name, address, runner) {
  return new Contract(address, artifacts[file][name].abi, runner);
}

/// Launches BLOOM, the platform token, once: 90% of supply trades on its own bonding curve
/// like any launch (graduating to a locked V4 pool, ...b00b address), and 10% is minted to a
/// team vesting contract: half unlocked at launch, half linear over 12 months. Then binds the buyback-and-burn contract.
/// The signer must still be the factory owner and the deployment bootstrapper (run it right
/// after deploySystem, before the governor accepts ownership).
export async function launchBloom({ signer, artifacts, contracts, weth, team, poolManagerLocker, params = {}, v2 = false,
  vestingSeconds = 365n * 86400n, immediateBps = 5000n, phantomQuote = 126n * 10n ** 16n, mineTokenSalt, log = () => {} }) {
  const factory = v2 ? attach(artifacts, 'contracts/v2/LaunchFactoryV2.sol', 'LaunchFactoryV2', contracts.LaunchFactory, signer)
    : attach(artifacts, 'contracts/LaunchFactory.sol', 'LaunchFactory', contracts.LaunchFactory, signer);
  const creator = await signer.getAddress();
  const provider = signer.provider;
  const start = BigInt((await provider.getBlock('latest')).timestamp);
  const vArt = artifacts['contracts/TeamVesting.sol'].TeamVesting;
  const vesting = await new ContractFactory(vArt.abi, vArt.evm.bytecode.object, signer).deploy(team ?? creator, start, vestingSeconds, immediateBps);
  await vesting.waitForDeployment();
  log(`TeamVesting: ${await vesting.getAddress()}`);
  // Same price curve as standard launches, scaled to the 90% that trades.
  const configId = Number(await factory.configCount());
  await (await factory.addConfig({ supply: 9n * 10n ** 26n, reservedTokens: 18n * 10n ** 25n, phantomQuote,
    quote: weth, executor: poolManagerLocker ?? contracts.LiquidityLocker, enabled: false })).wait();
  await (await factory.setConfigEnabled(configId, true)).wait();
  const reserve = 10n ** 26n; // 10% of the 1,000,000,000 total supply
  const p = { name: 'Bloom', symbol: 'BLOOM', metadataURI: '', creatorRecipient: team ?? creator, creatorBps: 0, holderShareBps: 0,
    buybackShareBps: 0, salt: '0x' + 'b1'.repeat(32), launchProtection: true, protectionExempt: [], ...params,
    expectedEconomics: await factory.previewEconomics(configId, weth), tokenSalt: '0x' + '00'.repeat(32) };
  const [dep, , initHash] = await factory.reserveTokenInitHash(creator, p, configId, weth, vesting, reserve);
  p.tokenSalt = (await mineTokenSalt(dep, initHash)).salt;
  const bloom = getCreate2Address(dep, p.tokenSalt, initHash);
  await (await factory.launchPlatformToken(p, configId, weth, vesting, reserve)).wait();
  // Later standard launches must not reuse the BLOOM-sized configuration.
  await (await factory.setConfigEnabled(configId, false)).wait();
  log(`BLOOM: ${bloom}`);
  const burner = attach(artifacts, 'contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', contracts.BloomBuybackBurner, signer);
  const adapter = attach(artifacts, 'contracts/v4/CanonicalBuybackAdapter.sol', 'CanonicalBuybackAdapter', contracts.BloomBurnAdapter, signer);
  await (await burner.bind(contracts.LaunchFactory, bloom, contracts.BloomBurnAdapter)).wait();
  await (await adapter.bindVault(contracts.BloomBuybackBurner)).wait();
  log('burner and burn adapter bound to BLOOM');
  return { bloom, vesting: await vesting.getAddress() };
}


/// Deploys the complete BloomLaunch v2 system (see deploySystem with v2: true).
export const deploySystemV2 = options => deploySystem({ ...options, v2: true });
