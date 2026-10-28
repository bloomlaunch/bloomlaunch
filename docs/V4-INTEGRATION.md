# Uniswap V4 integration work

Primary references read 28 October 2026:

- https://developers.uniswap.org/docs/protocols/v4/concepts/hooks
- https://developers.uniswap.org/docs/protocols/v4/concepts/poolmanager
- https://developers.uniswap.org/docs/protocols/v4/guides/custom-accounting

V4 stores pools inside a shared PoolManager. Hook callbacks are selected by
permission bits in the hook address. A production hook deployment must therefore
mine/validate a deterministic address with the intended permissions; an arbitrary
deployment address is insufficient. Initialization must restrict canonical
BloomLaunch pools to our executor and bind immutable per-launch economics.

PoolManager operations use delta accounting. During an unlock, a router or
executor must settle all owed assets and take all credits before returning.
Hook fees and return deltas must be tested against the real V4 core for both
asset orders and trade directions. A successful mock executor is not evidence
that this settlement is implemented correctly.

External infrastructure was read at RPC block 99,497,221 from the documented Pons
factory. `config/robinhood.references.json` records addresses, bytecode sizes and
hashes. This establishes code presence at that block only; interfaces, source
verification, deployment provenance and chain compatibility still need review.
BloomLaunch must deploy its own factory, fee hook, graduation executor and locker.

Acceptance requirements:

1. Real V4 pool initialization at a price derived from actual curve reserves.
2. Full-range liquidity position whose owner cannot withdraw principal.
3. No additional pool trading fee beyond the published hook economics.
4. Platform fee of 20 basis points and immutable creator fee of 0–1,000 basis
   points on the quote leg, with exact input/output semantics documented.
5. Quote-asset creator/holder/buyback allocation without recursive internal fees.
6. Terminal curve price and opening pool price checked using actual amounts.
7. Complete rollback when pool initialization, funding or locking fails.
8. Accurate quote previews and router min-output/deadline enforcement.
9. Local core integration and Robinhood testnet/fork verification before mainnet.

## Implementation status (28 October 2026)

Implemented: `contracts/v4/LiquidityLocker.sol` (executor + permanent lock),
`contracts/v4/BloomFeeHook.sol` (fees, executor-only initialization, TWAP accumulator),
`contracts/v4/CanonicalBuybackAdapter.sol`, `contracts/LaunchRouter.sol`. Acceptance items 1–8
are covered by `test/v4.test.mjs` against the real PoolManager from @uniswap/v4-core 1.0.2.
Item 9 (Robinhood testnet/fork) remains open. Production uses the chain's deployed PoolManager;
v4-core's PoolManager source is BUSL-1.1 and is compiled here only for local tests. BloomLaunch
imports only MIT-licensed V4 interfaces, types and libraries.

The MockGraduationExecutor remains exclusively a test boundary for state
rollback and retry logic. It creates no pool and proves no real liquidity lock.
