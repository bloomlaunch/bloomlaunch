# Verification record — 28 October 2026 (updated)

## Current run

Command: `npm test` — **31 passed, 0 failed, 0 skipped**.

Added after the first update: opening snipe protection (cap, creator exemption, early end, expiry); token
address suffix enforcement (`…b00b`) and configuration-to-quote binding; a full 6-decimal stablecoin
lifecycle through the V4 pool; and five migration tests against the real PoolManager (success through a
graduated replacement with vesting, rewards and 90-day burn; too few deposits; low proceeds with a blocked
old-token refund leg not blocking the quote leg; price floor; factory access and term validation).
Manually checked in the browser: USDC launch with protection, protected buy limit, creator ending
protection, migration deposit, migration claim, and creating a migration as governor.
Compiler: solc 0.8.38, optimizer 200 runs, viaIR, **Cancun** EVM target (required by Uniswap V4
transient storage). Uniswap V4 PoolManager compiled from @uniswap/v4-core 1.0.2 with solc 0.8.26
for local tests only. Execution: Hardhat 3.21.1 EDR, chain 31337, Node.js 22.23.3.

Added since the handoff (tests 15–24):

15. Deployment library deploys and wires the full system, rejects wrong chain ids and PoolManager
    code-hash mismatches, hands ownership to the governor, and the deployed system launches,
    graduates and charges exactly 0.20% on a pool trade.
16–17. Metadata sanitization: field allowlist, https-only links, bounded text; images checked by
    file signature and size.
18, 20. Real V4 graduation for both currency orders: pool initialized at the released-amount
    price; terminal curve price and pool price agree within 0.01%; the locker's full-range
    position liquidity read from PoolManager storage; no withdrawal functions on the locker;
    nobody else can initialize a pool with the hook; graduation cannot repeat; curve closes;
    a completing buy with too little gas reverts instead of skipping graduation.
19, 21. Hook fees on exact-input buy, exact-input sell, exact-output buy and exact-output sell in
    both currency orders: platform fee exactly floor(gross × 20 / 10,000); creator, holder and
    buyback allocations exact; only the net enters the pool; native ETH in/out; slippage and
    deadline enforcement; pool-funded holder rewards claimable; hook holds no balance.
22. After graduation, buyback disable/enable and a delayed takeover redirect future pool fees
    and buyback funding while the previous recipient keeps prior funding.
23. Canonical buyback: no execution before a 30-minute observation exists; execution refused
    while spot deviates from the TWAP; trade size capped by pool liquidity; the buyback trade
    pays the platform fee but funds no further buyback; vesting lot created.
24. Router-only `launchFor`, one-time router binding, stray-ETH rejection, price bounds of the
    locker, and exact platform fee for a zero-creator-fee launch.

Manual end-to-end check (local stack via `npm run dev`, in-app browser): discover list, launch with
metadata upload and first buy, curve buy capped at graduation with refund, automatic V4 graduation
shown as locked, pool buy and approve-then-sell matching quotes, portfolio, creator and governor
admin pages.

Not established: independent audit, fuzz/invariant campaign beyond the existing seeded sequence,
indexer behaviour under a real reorg (rollback logic is implemented but not tested against one),
Robinhood testnet/mainnet behaviour, production economics.

## Earlier record (handoff)


Command: `npm test`

Latest result: 14 tests passed, 0 failed, 0 skipped. Duration: 11.8 seconds.
Compiler: solc 0.8.38, optimizer enabled (200 runs), via IR, Shanghai EVM target.
Execution: Hardhat 3.21.1 EDR, local chain 31337 using Cancun rules, generated
test accounts, Node.js 22.23.3. No remote transaction endpoint or funded key.

Verified by contract transactions:

1. Fee and allocation conservation at boundary amounts, including maximum uint256,
   creator rate limits, and invalid allocation rejection.
2. Native escrow beneficiary isolation and restoration of credit when a recipient
   rejects payment, followed by a successful redirected withdrawal.
3. ERC-20 escrow withdrawals and atomic rejection of fee-on-transfer deposits.
4. Pending rewards with no eligible supply, historical reward ownership across
   transfers, future rewards following current balances, and repeated claim safety.
5. A deterministic 45-step randomized sequence of funding, transfers and claims,
   including self-transfers and excluded accounts. After each step, total claims
   and outstanding entitlements did not exceed funding; held reward assets matched
   funded assets minus paid claims; eligible supply matched eligible balances.
6. Gas-only factory creation, economic hash pinning, configuration disablement,
   invalid fee/allocation rejection and deployable factory/deployer bytecode sizes.
7. Buy and sell quote matching, creator/holder/buyback fee allocation, donations
   excluded from pricing reserves, deadlines, minimum output and access control.
8. Final input capping at both zero and maximum creator fee, minimal fee-inclusive
   gross input, actual terminal price alignment within one basis point, atomic
   failed-executor rollback and permissionless graduation retry.
9. Stalled graduation recovery after a verified seven-day delay, proportional
   redemption, no new refund fee and rejection of graduation after recovery.
10. Voluntary creator-rights transfer and delayed public takeover, without moving
    existing escrow earnings or changing the creator trading fee.
11. Real buyback vault funding from the curve; authenticated sources, one-time
    factory binding, creator toggles, governance disablement and unchanged platform fees.
12. Buyback limits, exact quote spend, minimum received tokens, bounded approvals,
    short deadlines and cooldowns; four failed swap modes restore custody and state.
13. Separate five-year purchase lots, partial and full vesting, bounded claims,
    permitted third-party payments, redirection protection and repeated claim safety.
14. Takeovers preserve old unspent funding and vesting, while new fee deposits
    accrue to the new beneficiary. Quote and token liabilities remain backed.

Manifest and lockfile dependency declarations were checked for agreement.
`npm audit --omit=dev` reported zero vulnerabilities for current production packages.
The full lockfile audit reported 3 high development-tool dependency findings, tracked
in DELIVERY.md.

The first delayed-recovery test run failed due to a cached pre-time-advance gas
estimate. The local provider cache was disabled, an explicit timestamp assertion
was added, and the targeted recovery test and entire suite then passed. No
production contract change was needed for this test failure.

The initial vesting scenario hit a timestamp-sensitive gas underestimate in the
old runner. A transaction trace ended inside a launch-token storage write before
the safe transfer propagated an empty revert. The unsigned client transaction
builder now applies gas headroom. The unchanged vesting logic passed the complete
scenario through that client path, and the full 14-case suite then passed on EDR.

Limits: these tests cover the current primitives, factory, curve and buyback/vesting vault. They do not verify an entire
launchpad, economic fairness, real Uniswap integration, Robinhood deployment compatibility,
mainnet behavior, or absence of all reward-accounting attacks. The randomized
sequence is one deterministic seed, not exhaustive fuzzing. Independent contract
review and broader invariants remain required.

The graduation executor and configurable buyback swap adapter are explicit test
doubles. The vault itself and its fee-funding path are real contracts under test.
The tests prove vault custody and vesting boundaries, not real pool creation,
real liquidity locking, TWAP enforcement or canonical-market buyback execution.
