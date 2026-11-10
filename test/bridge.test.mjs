import assert from 'node:assert/strict';
import test from 'node:test';
import { network } from 'hardhat';
import { BrowserProvider, ContractFactory, Interface, parseEther } from 'ethers';
import { output } from '../scripts/compile.mjs';

// Bridge with a 0.1% fee. BridgeOut is tested locally with stand-ins for the ArbOS precompile and the
// child gateway router. BridgeIn is tested on a fork of HyperEVM mainnet against Elysium's real Inbox
// (skipped with SKIP_FORK_TESTS=1, for offline runs).
const art = (file, name) => output.contracts[file][name];
const FEE_BPS = 10n;
const INBOX = '0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff';
const ROUTER_HYPEREVM = '0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0';

async function chain(name) {
  const connection = await network.create(name);
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 20;
  const rpc = (method, params = []) => connection.provider.request({ method, params });
  const signers = await Promise.all([0, 1, 2, 3].map(i => provider.getSigner(i)));
  const deploy = async (file, name, args = [], from = signers[0]) => {
    const c = await new ContractFactory(art(file, name).abi, art(file, name).evm.bytecode.object, from).deploy(...args);
    await c.waitForDeployment(); return c;
  };
  return { connection, provider, rpc, signers, deploy };
}

test('BridgeOut (Elysium -> HyperEVM): 0.1% fee, the rest withdrawn to the user, nothing kept', async () => {
  const s = await chain('local');
  try {
    const [owner, user, feeWallet, stranger] = s.signers;
    const arbSys = await s.deploy('test/Fixtures.sol', 'MockArbSys');
    await s.rpc('hardhat_setCode', ['0x0000000000000000000000000000000000000064', await s.provider.getCode(await arbSys.getAddress())]);
    const child = await s.deploy('test/Fixtures.sol', 'MockBridgedToken', [], user);
    const router = await s.deploy('test/Fixtures.sol', 'MockChildRouter', [await child.getAddress()]);
    const bridge = await s.deploy('contracts/bridge/BridgeOut.sol', 'BridgeOut',
      [await router.getAddress(), await owner.getAddress(), await feeWallet.getAddress(), FEE_BPS]);
    const out = new ContractFactory(art('test/Fixtures.sol', 'MockArbSys').abi, '0x').attach('0x0000000000000000000000000000000000000064').connect(s.provider);

    // HYPE
    const amount = parseEther('10');
    const feeBefore = await s.provider.getBalance(await feeWallet.getAddress());
    await (await bridge.connect(user).withdrawHype(await user.getAddress(), { value: amount })).wait();
    assert.equal(await s.provider.getBalance(await feeWallet.getAddress()) - feeBefore, amount * FEE_BPS / 10_000n, '0.1% to the fee wallet');
    assert.equal(await out.lastValue(), amount - amount * FEE_BPS / 10_000n, 'the rest goes to the official withdrawal');
    assert.equal(await out.lastDestination(), await user.getAddress());
    assert.equal(await s.provider.getBalance(await bridge.getAddress()), 0n, 'the bridge holds nothing');

    // Token
    const tokens = parseEther('1000');
    await (await child.connect(user).approve(await bridge.getAddress(), tokens)).wait();
    const parent = '0x000000000000000000000000000000000000bEEF';
    await (await bridge.connect(user).withdrawToken(await child.getAddress(), parent, tokens, await user.getAddress())).wait();
    assert.equal(await child.balanceOf(await feeWallet.getAddress()), tokens * FEE_BPS / 10_000n);
    assert.equal(await router.lastAmount(), tokens - tokens * FEE_BPS / 10_000n);
    assert.equal(await router.lastParent(), parent);
    assert.equal(await child.balanceOf(await bridge.getAddress()), 0n);

    // Fee settings: capped, owner only.
    await assert.rejects(bridge.setFee(51n, await feeWallet.getAddress()), 'fee capped at 0.5%');
    await assert.rejects(bridge.connect(stranger).setFee(5n, await stranger.getAddress()), 'owner only');
    await (await bridge.setFee(0n, await feeWallet.getAddress())).wait();
    assert.deepEqual([...(await bridge.quote(1000n))], [0n, 1000n]);
  } finally { await s.connection.close(); }
});

test('BridgeIn (HyperEVM -> Elysium) on a HyperEVM fork: 0.1% fee and a retryable ticket to the user through the real Inbox',
  { skip: process.env.SKIP_FORK_TESTS === '1' }, async () => {
  const s = await chain('hyperevmFork');
  try {
    const [owner, user, feeWallet] = s.signers;
    await s.rpc('hardhat_setBalance', [await user.getAddress(), '0x' + parseEther('100').toString(16)]);
    const bridge = await s.deploy('contracts/bridge/BridgeIn.sol', 'BridgeIn',
      [INBOX, ROUTER_HYPEREVM, await owner.getAddress(), await feeWallet.getAddress(), FEE_BPS]);
    const gasLimit = 100_000n, maxFeePerGas = 10n ** 9n;   // 1 gwei on Elysium (its base fee is 0.5 gwei)
    const arrive = parseEther('1');
    const baseFee = (await s.provider.getBlock('latest')).baseFeePerGas;
    const [value, fee] = await bridge.hypeValue(arrive, gasLimit, maxFeePerGas, baseFee * 2n);   // latest base fee + margin, as the site will pass
    const feeBefore = await s.provider.getBalance(await feeWallet.getAddress());
    const rc = await (await bridge.connect(user).depositHype(await user.getAddress(), gasLimit, maxFeePerGas, { value })).wait();
    const paid = await s.provider.getBalance(await feeWallet.getAddress()) - feeBefore;
    const ev = rc.logs.map(l => { try { return bridge.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'BridgedHype');
    assert.equal(paid, ev.args.fee, 'the fee reached the fee wallet');
    assert.equal(paid, (ev.args.amount + paid) * FEE_BPS / 10_000n, 'the fee is exactly 0.1% of what is bridged');
    assert.ok(paid >= fee - 1n, `quoted fee covered (${paid} vs ${fee})`);
    assert.ok(ev.args.amount >= arrive, `at least the requested amount arrives on Elysium (${ev.args.amount})`);
    // The Inbox recorded a message for Elysium (Nitro emits InboxMessageDelivered from the Inbox).
    const inboxIface = new Interface(['event InboxMessageDelivered(uint256 indexed messageNum, bytes data)']);
    assert.ok(rc.logs.some(l => l.address.toLowerCase() === INBOX.toLowerCase() && l.topics[0] === inboxIface.getEvent('InboxMessageDelivered').topicHash),
      'the real Inbox accepted the retryable ticket');
    assert.equal(await s.provider.getBalance(await bridge.getAddress()), 0n, 'the bridge holds nothing');
  } finally { await s.connection.close(); }
});
