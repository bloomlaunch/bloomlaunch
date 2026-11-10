# BloomLaunch contracts

Smart contracts for [BloomLaunch](https://bloomlaunch.fun), the token launchpad on [Elysium](https://elysium.kinetiq.xyz)
(Kinetiq's L2 for Hyperliquid, HYPE as gas). Launching is free: every launch makes a small first buy (at least
0.00014 HYPE, about $0.01) so the coin trades from its first block. Each token trades on a bonding curve that presents
itself as a Uniswap V3 pool (so market-data sites can detect it from the first trade) and graduates automatically into
a permanently locked Uniswap V4 pool. A fixed 0.10% platform fee per trade and a 0–10% creator fee the creator can share
with holders and buybacks. Half of platform revenue buys and burns BLOOM, the platform token. A HyperEVM ↔ Elysium bridge
wrapper charges a capped 0.1% fee on top of Elysium's official bridge.

[Website](https://bloomlaunch.fun) · [Developer docs](https://bloomlaunch.fun/docs) · [X](https://x.com/bloomlaunch)

## Deployed on Elysium mainnet (chain 99901)
Deployed 10 Nov 2026 (from block 4,007,532). All 23 contracts are source-verified on the
[Elysium explorer](https://elysium.kinetiq.xyz) with the exact build in this repository.

| Contract | Address |
|---|---|
| LaunchFactory (proxy) | [`0x8a5439F3c373208531E7B3454941A6cCC66A6081`](https://elysium.kinetiq.xyz/address/0x8a5439F3c373208531E7B3454941A6cCC66A6081?tab=contract) |
| LaunchRouter (proxy) | [`0x42ba1aFdaac55Bc4b07CC556A50C114B8f5c1911`](https://elysium.kinetiq.xyz/address/0x42ba1aFdaac55Bc4b07CC556A50C114B8f5c1911?tab=contract) |
| BLOOM token | [`0xf2Ef1287314dcc7e8422E917408861714B3FB00B`](https://elysium.kinetiq.xyz/address/0xf2Ef1287314dcc7e8422E917408861714B3FB00B?tab=contract) |
| BLOOM curve | [`0xE46553b41643A11EbeC747f10CdAc273142f34c8`](https://elysium.kinetiq.xyz/address/0xE46553b41643A11EbeC747f10CdAc273142f34c8?tab=contract) |
| LiquidityLocker (immutable) | [`0x06B3df832eFDfA3031C1DdC194604f73944D9c4E`](https://elysium.kinetiq.xyz/address/0x06B3df832eFDfA3031C1DdC194604f73944D9c4E?tab=contract) |
| BloomFeeHook (immutable, Uniswap V4 hook) | [`0x16D96af9204cE43A75369f88A39C6B73305e20cc`](https://elysium.kinetiq.xyz/address/0x16D96af9204cE43A75369f88A39C6B73305e20cc?tab=contract) |
| LaunchDeployer | [`0xbA2201d1e24E90d29347B19d92ad249b9CbbBdf1`](https://elysium.kinetiq.xyz/address/0xbA2201d1e24E90d29347B19d92ad249b9CbbBdf1?tab=contract) |
| FeeEscrow (proxy) | [`0x4e9F243766374C1d2E0c76Ef84E78A450e1Bde8b`](https://elysium.kinetiq.xyz/address/0x4e9F243766374C1d2E0c76Ef84E78A450e1Bde8b?tab=contract) |
| BuybackVestingVault (proxy) | [`0xCA948CE3d18008203C22643c871B053D9a845729`](https://elysium.kinetiq.xyz/address/0xCA948CE3d18008203C22643c871B053D9a845729?tab=contract) |
| CanonicalBuybackAdapter (proxy) | [`0xd5bf4b23c74621b28D8e66dB8524Ea702751ECAa`](https://elysium.kinetiq.xyz/address/0xd5bf4b23c74621b28D8e66dB8524Ea702751ECAa?tab=contract) |
| LimitOrderExecutor (proxy) | [`0x55aDeFfe076536c686ea8025EA04ba5fe60932a0`](https://elysium.kinetiq.xyz/address/0x55aDeFfe076536c686ea8025EA04ba5fe60932a0?tab=contract) |
| BloomBuybackBurner (proxy) | [`0x0f5D9B280fd1B6EF300a1D806E9f45b4c83c97b1`](https://elysium.kinetiq.xyz/address/0x0f5D9B280fd1B6EF300a1D806E9f45b4c83c97b1?tab=contract) |
| BloomBurnAdapter (proxy) | [`0x284C6b98fB4c3c8fc870e61C90b3cD40e4878523`](https://elysium.kinetiq.xyz/address/0x284C6b98fB4c3c8fc870e61C90b3cD40e4878523?tab=contract) |
| BridgeOut (Elysium → HyperEVM) | [`0xA029c406A229374b71CC876D59281711109f01D7`](https://elysium.kinetiq.xyz/address/0xA029c406A229374b71CC876D59281711109f01D7?tab=contract) |
| BridgeIn (HyperEVM → Elysium, on HyperEVM 999) | `0x4aBeD3d9FeC76ffe1F578dD5CfC6c1e7B42f75ff` |

Full record, including every implementation address: [`config/elysium-mainnet.deployment.json`](config/elysium-mainnet.deployment.json).
Verification inputs (contract names and constructor arguments): [`verification/elysium-mainnet.json`](verification/elysium-mainnet.json).

### Upgrades and what can never change
The factory, router, fee escrow, buyback vault and adapters, BLOOM burner and limit-order executor run behind
ERC-1967 (UUPS) proxies; only the factory owner can upgrade them ([`contracts/proxy/CoreUpgradeable.sol`](contracts/proxy/CoreUpgradeable.sol)).
**Never upgradeable:** every launched token and its bonding curve, the liquidity locker (graduated liquidity stays
locked forever) and the V4 fee hook (pool fees cannot change). Holders trust the owner not to upgrade the proxied
contracts maliciously; a timelock or multisig owner is the planned next step.

### Earlier deployment: Robinhood Chain (chain 4663)
BloomLaunch ran on Robinhood Chain first (v1 and v2, 28–29 Oct 2026). Those contracts stay onchain and keep working
for their tokens; the code as deployed there is tagged `robinhood-v2`. Records:
[`config/robinhood-mainnet.deployment.json`](config/robinhood-mainnet.deployment.json) (v2) and
[`config/robinhood-mainnet-v1.deployment.json`](config/robinhood-mainnet-v1.deployment.json).

## Contracts
| Path | Purpose |
|---|---|
| `contracts/v2/LaunchFactoryV2.sol` | Creates each token and its bonding curve (addresses end in `b00b`), graduation, creator controls, launch terms (owner-set, capped) |
| `contracts/v2/LaunchRouterV2.sol` | Native-HYPE router across the curve and the Uniswap V4 pool; launch = fee + first buy in one transaction |
| `contracts/v2/BondingCurveV2.sol` | Per-token curve: buys, sells, snipe protection, graduation, refunds, plus Uniswap V3 pool views and `Initialize`/`Swap` events |
| `contracts/v2/LaunchDeployerV2.sol` | CREATE2 deployment of token and curve |
| `contracts/LaunchToken.sol` | Fixed-supply ERC-20 with a claimable holder-reward ledger |
| `contracts/FeeMath.sol` | 0.10% platform fee, 0–10% creator fee and its split |
| `contracts/FeeEscrow.sol` | Escrowed creator and platform fees, claimable by beneficiaries only |
| `contracts/LimitOrderExecutor.sol` | Signed (EIP-712) limit orders filled by anyone |
| `contracts/BuybackVestingVault.sol` | Creator buybacks at a TWAP-bounded price, vesting over 5 years |
| `contracts/BloomBuybackBurner.sol` | Platform revenue: 50% buys and burns BLOOM, 50% to the treasury |
| `contracts/v4/BloomFeeHook.sol` | Uniswap V4 hook: fees on the quote leg and a TWAP oracle |
| `contracts/v4/LiquidityLocker.sol` | Creates the graduation pool and locks its liquidity permanently |
| `contracts/v4/CanonicalBuybackAdapter.sol` | TWAP-guarded buyback swaps on the canonical pool |
| `contracts/proxy/` | UUPS upgrade hook (factory owner only) and the bootstrap implementation used during deployment |
| `contracts/bridge/` | `BridgeIn` (HyperEVM) and `BridgeOut` (Elysium): capped fee, the rest through Elysium's official bridge, nothing held |
| `contracts/LaunchFactory.sol`, `LaunchRouter.sol`, `BondingCurve.sol`, `LaunchDeployer.sol`, `TeamVesting.sol`, `migration/` | v1 (Robinhood Chain) |

Design notes: [`docs/ELYSIUM-PLAN.md`](docs/ELYSIUM-PLAN.md), [`docs/V2-DESIGN.md`](docs/V2-DESIGN.md),
[`docs/SPECIFICATION.md`](docs/SPECIFICATION.md), [`docs/CURVE-MATH.md`](docs/CURVE-MATH.md),
[`docs/V4-INTEGRATION.md`](docs/V4-INTEGRATION.md), [`docs/BUYBACKS.md`](docs/BUYBACKS.md).
For indexers: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Build and test
Requires Node.js 22.
```bash
npm install
npm test                 # contracts, Uniswap V4, deployment, migration, BLOOM, v2, bridge and fuzz tests
npm run test:fuzz        # stateful fuzzing only; FUZZ_SEED and FUZZ_STEPS to reproduce or extend
npm run dryrun:elysium   # the full deploy and a token lifecycle on a local fork of Elysium mainnet (nothing sent)
npm run verify:elysium   # re-submit source verification to the Elysium explorer
```
The bridge test includes a check against Elysium's real Inbox on a local fork of HyperEVM (set `SKIP_FORK_TESTS=1` offline).
Contracts compile with solc 0.8.38 (via-IR, optimizer 200 runs, Cancun). Uniswap V4 core 1.0.2 is compiled
with solc 0.8.26 for local tests against the real PoolManager.

## Security
Internal review with Slither static analysis and stateful fuzzing: [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md).
**No independent audit yet.** Tokens launched on BloomLaunch are highly speculative; nothing here is financial advice.

## License
[MIT](LICENSE)
