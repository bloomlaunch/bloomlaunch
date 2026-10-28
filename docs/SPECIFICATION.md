# Robinhood launchpad — technical specification

Status: implementation specification draft, 28 October 2026. No contracts have been deployed and no production application has been built.

## 1. Confirmed requirements

- Robinhood Chain only.
- Full feature scope comparable to Pons v2, implemented under our own branding and contracts.
- Zero platform token creation fee. The initiating user pays network gas.
- Platform earns 0.20% of each buy and sell through the launch curve and canonical graduated pool.
- Creator selects an additional fee from 0% to 10%, fixed for the token's lifetime.
- Creator may share its fee allocation with holders and fund optional buybacks.
- Standard combined trading fee ranges from 0.20% to 10.20%, excluding gas and any separately disclosed launch protection mechanism.
- Bonding curves, graduation, permanently locked liquidity, creator payouts, buybacks and vesting, community takeovers, external-token migrations, custom quote assets, charts, discovery, and administration are in scope.

## 2. Fee specification

Use integer basis points: denominator 10,000; platform rate 20; creator rate 0–1,000. Never use floating-point arithmetic for settlement.

For a buy, the fee base is the actual gross quote amount consumed. Compute platform and creator fees separately with rounding down; the remainder funds curve pricing or pool execution. If graduation consumes only part of a buy, calculate fees on the consumed portion and refund unused input. Quotes must simulate the exact transaction, including rounding and partial fills.

For a sell, first calculate gross quote output. Deduct platform and creator fees from that output; send the remainder to the seller. Minimum output and deadline protections apply to the actual amount received.

For a 100-unit fee base and 3% creator fee: platform receives 0.20 units, creator allocation receives 3 units, and total fee is 3.20 units. Quote assets can be ETH or approved ERC-20 assets; USD figures in the interface are estimates.

The creator allocation is divided among creator earnings, holder rewards, and optional buybacks. Allocation shares must sum to 100% of the creator allocation. The platform's 0.20% is never reduced by those allocations. A zero creator fee means no new holder rewards or buyback funding from trades.

Proposed default: creator allocation shares are fixed at launch. A payout wallet can change through an authenticated operation; accrued balances remain owned by their original beneficiary. Changing allocation rules would require a separate, explicit product decision.

The canonical graduated pool should have zero additional pool fee, with the hook collecting the agreed fees. Validate this against the selected Uniswap V4 deployment before implementation. Fees on unrelated pools or direct wallet transfers are not guaranteed; we should not impose a transfer tax merely to capture those markets.

## 3. Proposed contract architecture

Budget for approximately 16 contract types. This is an engineering estimate, not a finalized deployment count. Libraries, implementation contracts, shared external infrastructure, and multisig accounts are counted separately.

| Type | Responsibility | Deployment pattern |
|---|---|---|
| LaunchFactory | Launch records, approved configurations, authenticated creation | Shared |
| LaunchDeployer | Deterministic deployment of tokens and curves | Shared |
| LaunchToken | Fixed-supply ERC-20, metadata, reward accounting integration | Per normal launch |
| BondingCurve | Pricing, reserves, buy/sell settlement and fee collection | Per normal launch |
| GraduationGuard | Validates reserves, price, asset ordering and pool parameters | Shared |
| GraduationExecutor | Creates canonical pool and locked liquidity atomically | Shared |
| LiquidityLocker | Holds pool positions permanently; exposes no liquidity withdrawal path | Shared |
| TradingFeeHook | Collects post-graduation fees on canonical pools | Shared |
| FeeEscrow | Segregated platform and creator claimable balances | Shared |
| BuybackVestingVault | Bounded buybacks and beneficiary vesting records | Shared with per-token accounting |
| LaunchAndTradeRouter | Launch plus buy, quote execution and transition routing | Shared |
| HolderRewardTracker | Maintains eligible balances and reward accrual without holder loops | Per reward-enabled token |
| HolderRewardDistributor | Holds and pays rewards by token and quote asset | Shared |
| MigrationFactory | Deploys migrations with fixed terms | Shared |
| MigrationEscrow | Deposits, epochs, bounded sales, refunds and settlement | Per migration |
| MigrationToken | Replacement token with bounded claims and mint closure | Per migration |

Launch tokens must have no privileged mint, confiscation, blacklist, or liquidity withdrawal function. Reward accounting hooks must not give administrators powers over user balances.

Community takeover proposals and execution can live in the factory; they do not necessarily require another contract. Migration replacement tokens are separate from ordinary fixed-supply launch tokens because their claim lifecycle differs.

Uniswap V4 PoolManager, position management, approval infrastructure, and wallet infrastructure are external dependencies. A V4 pool is pool state within a shared manager, not necessarily a separately deployed pool contract.

## 4. Holder reward design

Proposed implementation: continuous cumulative rewards per eligible token balance, paid in the launch's quote asset. Each reward-enabled token maintains a high-precision cumulative reward index and per-wallet corrections. Transfers settle accounting so moving tokens cannot transfer already-earned rewards or claim them twice.

This rewards balances while fee revenue accrues; it is not a periodic balance snapshot or a promised fixed yield. A wallet joining later cannot claim earlier distributions. It is not a guarantee against every transaction-ordering strategy; economic simulations must assess reward capture and wash-trading costs.

Exclude curve inventory, canonical pool inventory, permanently locked supply, burn balances, escrow balances, and protocol-owned reward/buyback inventory. Exclusion rules are established at launch and graduation; arbitrary administrator exclusions are not allowed. Ordinary contract wallets remain eligible unless explicitly excluded by a published protocol role.

Accrue rewards without sending assets during swaps or token transfers. Holders claim separately. One reverting claimant cannot block trading or other claims. If no eligible supply exists, retain the rewards as pending until eligible supply exists. Dust remains accounted for and cannot be swept into platform income.

Use one quote asset per token. Launch-time quote assets must be vetted for transfer behavior; reject rebasing and fee-on-transfer assets in the initial implementation. Derive each tracker's eligible supply from token balance changes, with explicit handling of minting, burning and graduation.

## 5. Launch and graduation lifecycle

1. Creator chooses metadata, supported quote asset, enabled launch configuration, fee rate, payout wallet and allocation shares.
2. UI reads current configuration and pins its hash, so a changed configuration cannot silently alter a pending launch.
3. Factory deploys token and curve, records immutable terms, and mints the fixed supply into curve inventory. A fixed portion is reserved for graduation.
4. Curve supports buys and sells with exact fee settlement, deadlines and slippage limits.
5. When the graduation condition is met, trading transitions through an explicit state machine into the canonical pool. A permissionless retry can finish a failed graduation.
6. Pool price and liquidity derive from the curve's terminal economics. Liquidity position ownership goes directly to the permanent locker.
7. Subsequent canonical pool trades use the same platform and creator fee rates.

Required states: CurveActive, GraduationPending, PoolActive, and Refunded. Graduation must not execute twice; funds cannot be tradable on the curve while committed to pool initialization. Failed graduation recovery needs a published delay and an independently reviewed entitlement calculation, rather than an administrator-selected refund list.

Proposed supply default: one billion tokens with 18 decimals. Curve equation, reserved supply percentage, starting price, and graduation target remain economic design choices. Calibrate them together; do not independently copy a target and price from another system.

## 6. Launch protection

Launch protection is required, but a temporary purchase tax is not yet approved. A Pons-style decaying opening tax would exceed the ordinary advertised trading fee, so it must not be silently added to the 0.20–10.20% model.

Evaluate a scheduled opening and bounded initial purchases versus a separately disclosed decaying tax. Any selected limits must have a finite, immutable duration, public exemptions if any, and quotes that reflect execution. No protection should be described as eliminating bots or MEV.

## 7. Buybacks and vesting

Optional buybacks spend only the creator allocation designated for them. Platform revenue remains 0.20% of normal qualifying trade volume.

Use minimum output, bounded execution size, cooldowns and price-impact limits. Do not force a buyback through an illiquid market. Operators may trigger execution but cannot choose arbitrary recipients or bypass constraints. Execution on the canonical pool must avoid recursively triggering another internal buyback.

Proposed vesting term: five years, with new purchases starting their own vesting schedule or an equivalently reviewed weighted schedule. Proposed beneficiary: the creator recipient, with existing vesting rights preserved across payout-wallet changes. Do not allocate bought-back tokens to the platform without further agreement: the user requires platform earnings to come from trading fees only.

## 8. Community takeovers

Support voluntary transfer of future creator rights and a public delayed recovery process for abandoned projects. Proposed recovery delay: three days, followed by a three-day execution window. Record proposal, cancellation and execution events.

A takeover cannot alter the token fee rate, holder allocation, total supply, existing earned rewards, prior vesting rights, pricing or locked liquidity. Governance can redirect only the future rights explicitly covered by the published recovery rules.

## 9. External-token migrations

Support old-token deposit windows with fixed epoch rates and caps, a minimum participation threshold, and fixed deadlines. Before irreversible sale commitments, apply the published withdrawal rules. Execute old-token sales in bounded batches with cooldowns and manipulation-resistant price limits.

Use recovered quote assets to seed a replacement pool under fixed settlement rules. Replacement claims must be bounded by deposits, epoch terms and recovered value; close minting permanently after the claim window. Proposed claim window: 90 days. Proposed short claim vesting: configured and disclosed before deposits open.

If a migration fails, depositors reclaim their attributable unsold assets and recovered proceeds. A failing old-token transfer must not block withdrawal of the other asset. No administrator may withdraw depositor funds.

Fee treatment for migration sales, initial pool funding and replacement claims must be explicitly specified before implementation. Proposed default: no platform deposit, claim, settlement or graduation fee; ordinary trades through our canonical markets incur normal trading fees. Any external DEX sale can incur that venue's fee and price impact.

## 10. Application and infrastructure

- Wallet connection, chain switching, token approvals, transaction simulation, execution status and readable errors.
- Token creation with full fee and allocation previews.
- Launch discovery, search, filters and token address verification surfaces.
- Token pages with chart candles, trades, liquidity, holders, graduation progress and risk-relevant contract permissions.
- Buy/sell quotes showing platform fee, creator fee, any opening protection charge, minimum received, gas estimate and price impact separately.
- Creator dashboard for earnings, reward allocations, buybacks, vesting and takeover actions.
- Holder dashboard for claimable rewards and history.
- Migration pages for deposits, epochs, settlement, claims and refunds.
- Admin dashboard for supported assets, future launch configurations, narrowly scoped emergency controls and takeover proposals.
- RPC service with fallback, bounded historical event backfills, reorg-aware indexing, relational storage, object storage, live updates, monitoring and alerting.

Onchain state is authoritative. Offchain services accelerate discovery and reporting; they cannot fabricate balances or authorize withdrawals. Metadata uploads must be size-limited and sanitized, and external links must not execute inside privileged application contexts.

Suggested stack: TypeScript frontend, viem-compatible wallet integration, Solidity contracts, Foundry tests, and a TypeScript indexer with PostgreSQL. Hosting selection must match the indexer's execution and database requirements.

## 11. Administration and security

Use a multisig for privileged actions. Document each permission. Any pause must be limited in scope, observable and designed around users' ability to claim or recover assets. Existing launch fees and immutable economics cannot be changed by editing future configurations.

Required verification includes unit and integration tests, fuzzing, economic simulations, invariant tests, testnet end-to-end exercises and independent review before mainnet.

Critical invariants: conservation of assets; reserves exclude owed fees; platform gets exactly its rounded fee; allocation totals reconcile; reward claims never exceed funding; transfers cannot duplicate rewards; migration claims cannot exceed entitlements; graduation cannot repeat; locked liquidity cannot be withdrawn; unsupported assets cannot enter pricing paths; rounding and partial fills cannot create value.

Test reentrancy, malicious token behavior, failed native transfers, approval abuse, hook callbacks, decimal differences, empty supply, price manipulation, graduation retries, reorg recovery and migration deadline boundaries.

## 12. Remaining implementation inputs

Confirmed scope does not require repeated approval. Remaining product inputs are platform name/branding and the treasury recipient before deployment. Technical proposals needing final selection are curve economics, launch protection, holder reward allocation mutability, vesting beneficiary rules, migration economics and emergency recovery rules.

Development can begin with local defaults and test wallets. Mainnet deployment requires funded deployment accounts, reviewed contracts and configured multisig ownership. Private keys must never be placed in source code or chat.

## 13. Reference basis

- Pons v2 protocol and integration docs: https://docs.ponsfamily.com/v2
- Pons factory documented address: 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
- Research performed 28 October 2026: factory reads at RPC block 99,480,574 returned launchFee = 500000000000000 wei, maxCreatorTaxBps = 1000, and launch config 0 curveFeeBps = 100. These are competitor settings, not our settings.
- ZERO example curve read at RPC block 99,480,743 returned feeBps = 100 and protocolFeeShareBps = 3000, demonstrating a 0.30% retained protocol share for that launch. Do not generalize one launch's snapshot to all historical launches.

This specification proposes our own architecture. Similar features do not imply source-code reuse rights, partnership, or identical deployment behavior.
