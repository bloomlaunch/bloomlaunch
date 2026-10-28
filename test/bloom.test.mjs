import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, MaxUint256, keccak256 } from 'ethers';
import { output } from '../scripts/compile.mjs';
import { CREATE2_PROXY, attach, deploySystem, launchBloom } from '../scripts/deploy-lib.mjs';
import { mineTokenSalt } from '../sdk/vanity.mjs';

const PROXY_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';
const E18 = 10n ** 18n;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const tx = async p => (await p).wait();

test('BLOOM buyback-and-burn: 50% of platform ETH revenue buys BLOOM on its pool and burns it', async () => {
  const connection = await network.create('local');
  try {
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 20;
    const w = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(i => provider.getSigner(i)));
    const a = await Promise.all(w.map(x => x.getAddress()));
    const advance = async seconds => {
      await connection.provider.request({ method: 'evm_increaseTime', params: [seconds] });
      await connection.provider.request({ method: 'evm_mine', params: [] });
    };
    const deadline = async () => BigInt((await provider.getBlock('latest')).timestamp) + 240n;
    await connection.provider.request({ method: 'hardhat_setCode', params: [CREATE2_PROXY, PROXY_RUNTIME] });
    const art = (file, name) => output.contracts[file]?.[name] ?? output.v4core[file][name];
    const deployArt = async (file, name, args = []) => {
      const c = await new ContractFactory(art(file, name).abi, art(file, name).evm.bytecode.object, w[0]).deploy(...args);
      await c.waitForDeployment(); return c;
    };
    const pm = await deployArt('@uniswap/v4-core/src/PoolManager.sol', 'PoolManager', [a[0]]);
    const weth = await deployArt('test/Fixtures.sol', 'MockWETH');
    const treasury = a[6];
    const config = { chainId: 31337, poolManager: await pm.getAddress(), poolManagerCodeHash: keccak256(await provider.getCode(pm)),
      weth: await weth.getAddress(), governor: a[0], platformRecipient: treasury, bloomBurnBps: 5000,
      launchConfig: { supply: '1000000000000000000000000000', reservedTokens: '200000000000000000000000000', phantomQuote: '1400000000000000000' } };
    const { contracts } = await deploySystem({ signer: w[0], artifacts: output.contracts, config });
    const at = (file, name, address, signer = w[0]) => attach(output.contracts, file, name, address, signer);
    const factory = at('contracts/LaunchFactory.sol', 'LaunchFactory', contracts.LaunchFactory);
    const burner = at('contracts/BloomBuybackBurner.sol', 'BloomBuybackBurner', contracts.BloomBuybackBurner);
    const escrow = at('contracts/FeeEscrow.sol', 'FeeEscrow', contracts.FeeEscrow);
    assert.equal(await factory.platformRecipient(), contracts.BloomBuybackBurner, 'burner receives platform fees');
    await assert.rejects(burner.executeBurn(1, await deadline()), 'nothing bound or pending yet');

    const team = a[3];
    const { bloom, vesting } = await launchBloom({ signer: w[0], artifacts: output.contracts, contracts, weth: config.weth, team, mineTokenSalt });
    // 10% of BLOOM is minted to the team's vesting contract (half unlocked, half over 12 months); 90% trades on the curve.
    const bloomToken0 = at('contracts/LaunchToken.sol', 'LaunchToken', bloom);
    assert.equal(await bloomToken0.totalSupply(), 10n ** 27n);
    assert.equal(await bloomToken0.balanceOf(vesting), 10n ** 26n);
    assert.equal(await factory.platformToken(), bloom);
    const vest = at('contracts/TeamVesting.sol', 'TeamVesting', vesting, w[3]);
    assert.equal(await vest.owner(), team);
    const atLaunch = await vest['releasable(address)'](bloom);
    assert.ok(atLaunch >= 5n * 10n ** 25n && atLaunch < 5n * 10n ** 25n + 10n ** 21n, '50M unlocked at launch, the rest locked');
    assert.equal(await vest.immediateBps(), 5000n);
    await assert.rejects(factory.launchPlatformToken({ name: 'X', symbol: 'X', metadataURI: '', creatorRecipient: a[0], creatorBps: 0,
      holderShareBps: 0, buybackShareBps: 0, salt: '0x' + '00'.repeat(32), expectedEconomics: '0x' + '00'.repeat(32),
      tokenSalt: '0x' + '00'.repeat(32), launchProtection: false, protectionExempt: [] }, 0, weth, vesting, 1n), 'only one platform token');
    assert.ok(bloom.toLowerCase().endsWith('b00b'), 'BLOOM is an ordinary BloomLaunch token');
    assert.equal(await burner.bloom(), bloom);
    await assert.rejects(burner.bind(contracts.LaunchFactory, bloom, contracts.BloomBurnAdapter), 'binding is one-time');
    const router = at('contracts/LaunchRouter.sol', 'LaunchRouter', contracts.LaunchRouter, w[2]);
    const buy = value => tx(router.buy(bloom, value, 1, a[2], 2n ** 64n, { value }));
    await advance(301); // after opening protection
    await buy(10n * E18); // graduates BLOOM to its locked pool
    await buy(2n * E18);

    // Platform revenue: half to the treasury, half reserved for burning.
    const owed = await escrow.balances(weth, burner);
    assert.ok(owed > 0n);
    const treasuryBefore = await weth.balanceOf(treasury);
    await tx(burner.connect(w[5]).claim(weth));
    const toBurn = owed * 5000n / 10_000n;
    assert.equal(await burner.burnPending(), toBurn);
    assert.equal(await weth.balanceOf(treasury) - treasuryBefore, owed - toBurn);

    // Revenue in assets other than BLOOM's pair goes to the treasury in full.
    const usdc = await deployArt('test/Fixtures.sol', 'MockUSDC');
    await tx(usdc.approve(escrow, MaxUint256));
    await tx(escrow.depositToken(usdc, burner, 1_000_000n));
    await tx(burner.claim(usdc));
    assert.equal(await usdc.balanceOf(treasury), 1_000_000n);
    assert.equal(await burner.burnPending(), toBurn);

    // No TWAP yet: the burn is refused rather than executed at a manipulable price.
    await assert.rejects(burner.executeBurn(toBurn / 2n, await deadline()));
    for (let i = 0; i < 4; i++) { await advance(600); await buy(E18 / 100n); }
    await assert.rejects(burner.executeBurn(toBurn + 1n, await deadline()), 'cannot spend more than pending');
    await assert.rejects(burner.executeBurn(toBurn, 2n ** 64n), 'deadline bound');
    const bloomToken = at('contracts/LaunchToken.sol', 'LaunchToken', bloom);
    const deadBefore = await bloomToken.balanceOf(DEAD);
    const receipt = await tx(burner.connect(w[4]).executeBurn(toBurn, await deadline()));
    const burned = await bloomToken.balanceOf(DEAD) - deadBefore;
    assert.ok(burned > 0n, 'BLOOM sent to the burn address');
    assert.equal(await burner.totalBurned(), burned);
    assert.equal(await burner.totalSpent(), toBurn);
    assert.equal(await burner.burnPending(), 0n);
    const event = receipt.logs.map(l => { try { return burner.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'BloomBurned');
    assert.equal(event.args.bloomBurned, burned);

    // 50M is free at launch; the other 50M unlocks linearly: 75M total after six months, all after twelve.
    await advance(Math.floor(365 * 86400 / 2));
    const half = await vest['releasable(address)'](bloom);
    assert.ok(half > 74n * 10n ** 24n && half < 76n * 10n ** 24n);
    await tx(vest['release(address)'](bloom));
    assert.ok(await bloomToken0.balanceOf(team) >= half);
    await advance(365 * 86400);
    await tx(vest['release(address)'](bloom));
    assert.equal(await bloomToken0.balanceOf(vesting), 0n);
    assert.ok(await bloomToken0.balanceOf(team) >= 10n ** 26n);

    // The treasury can add converted revenue to future burns.
    await tx(weth.connect(w[6]).deposit({ value: E18 / 10n }));
    await tx(weth.connect(w[6]).approve(burner, MaxUint256));
    await tx(burner.connect(w[6]).depositForBurn(E18 / 10n));
    assert.equal(await burner.burnPending(), E18 / 10n);
  } finally { await connection.close(); }
});
