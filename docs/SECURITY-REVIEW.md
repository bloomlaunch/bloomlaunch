# Internal security review (28 Oct 2026)

Internal review, not an independent audit. Get an external audit before mainnet.

## Scope and method
- Manual line-by-line review of all 18 contracts (`contracts/`, `contracts/v4/`, `contracts/migration/`), the indexer
  API, keeper, Cloudflare worker and web app.
- Slither 0.11.6 static analysis (solc 0.8.38, via-IR, Cancun) on every top-level contract.
- Stateful fuzzing (`test/invariants.test.mjs`, `npm run test:fuzz`): seeded random sequences of curve and pool
  trades (all four exact-in/exact-out directions), transfers, reward and fee claims, round trips, time jumps,
  graduation and buybacks, on an ETH launch and a 6-decimal USDC launch with odd fee rates. Invariants are checked
  after every step: curve reserves match balances; escrow and buyback vault are exactly backed; holder rewards are
  solvent with bounded rounding dust; router, hook, locker and adapter never keep balances; liquidity stays locked;
  graduation never stays pending; round trips never profit; fee splits match the formula. Plus a property test
  of `FeeMath` (exact fees, full allocation, minimal gross-for-net). Reproduce a run with `FUZZ_SEED=<n>`.
- End-to-end run on Robinhood Chain testnet (`scripts/testnet-check.mjs`): 14/14 checks passed.

## Fixed
| Severity | Issue | Fix |
|---|---|---|
| Medium | Pool sells: the router held the seller's tokens while the fee hook funded holder rewards, so the router accrued (unclaimable) a share of that trade's rewards, proportional to the sell size. Found by the fuzzer. | Router is now excluded from rewards in every launch token (`LaunchFactory._exclusions`). Tokens launched by a factory deployed before this fix (the first testnet deployment) keep the old behaviour. |
| High | The router fix above also made curve sells revert (the curve refused to pay sell proceeds to a reward-excluded recipient), breaking pre-graduation selling and limit sells. Caught by the testnet redeploy; the fuzzer had tolerated failed trades. | The excluded-recipient check now applies only to buys; the fuzzer requires every trade type to succeed in each phase. |
| Medium | Metadata uploads had no rate limit (storage abuse). | Per-IP limit. |
| Medium | Behind Cloudflare all visitors shared one rate-limit bucket. | `TRUST_PROXY=cloudflare` uses `CF-Connecting-IP`. |
| Low | Negative or junk `limit` query parameters returned every row. | Clamped integer parameters. |
| Low | Site could be framed (clickjacking of wallet prompts). | `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS. |
| Low | Deploy script could reuse a nonce when the RPC lagged. | `NonceManager`. |

## Open (decisions, not code defects)
- **Medium: migration sales can be sandwiched.** `Migration.sellTranche` is permissionless and prices against
  spot, bounded by `maxImpactBps` and the creator's `floorPriceX18`. Options: keeper-only sales, or a TWAP bound.
- **Low: buyback and burn execution** can be nudged about 1-3% (30-minute TWAP, 100-tick spot deviation, 3% slippage
  and 1%-of-liquidity caps bound it).
- **Low: governor powers** (creator-fee takeover after 3 days, disabling buybacks, migration creation). Move the
  governor to a multisig and disclose these powers in the terms.
- **Low: signed API requests** can be replayed within their 10-minute window (actions are idempotent or harmless).

## Slither triage
All High/Medium detector hits were reviewed and are false positives: signature-authorised `transferFrom` in
`LimitOrderExecutor`, caller-funded ETH payouts in `LaunchRouter`, balance checks around the trusted immutable
adapter, the oracle ring-buffer index flagged as "weak PRNG", calls into trusted protocol contracts under
`nonReentrant`, intentionally ignored PoolManager return values, and `== 0` checks.
