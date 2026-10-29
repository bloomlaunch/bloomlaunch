# BloomLaunch contracts

Smart contracts for [BloomLaunch](https://bloomlaunch.fun), the token launchpad on Robinhood Chain.
Launches cost a $0.10 fee plus a small first buy. Each token trades on a bonding curve that presents itself as a
Uniswap V3 pool (so market-data sites can detect it from the first trade) and graduates automatically into a
permanently locked Uniswap V4 pool. A fixed 0.20% platform fee per trade and a 0–10% creator fee the creator can share
with holders and buybacks. Half of platform revenue (trading and launch fees) buys and burns BLOOM, the platform token.

[Website](https://bloomlaunch.fun) · [Developer docs](https://bloomlaunch.fun/docs) · [X](https://x.com/bloomlaunch)

## Deployed on Robinhood Chain mainnet (chain 4663)
BloomLaunch v2, deployed 29 Oct 2026 (block 100,752,870). Source-verified on [Etherscan](https://robin.etherscan.io),
[Blockscout](https://robinhoodchain.blockscout.com) and Sourcify (exact match).

| Contract | Address |
|---|---|
| LaunchFactory (v2) | [`0x1D797BbAb0Bb1d3cb575139898e8ceA1B71059D2`](https://robin.etherscan.io/address/0x1D797BbAb0Bb1d3cb575139898e8ceA1B71059D2#code) |
| LaunchRouter (v2) | [`0x5283A23a0D0872D74Ae448Fb6918e01D1faAbfb8`](https://robin.etherscan.io/address/0x5283A23a0D0872D74Ae448Fb6918e01D1faAbfb8#code) |
| LaunchDeployer (v2) | [`0x19713E501941F64e67c8E7B5A84b6DA534FdB0c1`](https://robin.etherscan.io/address/0x19713E501941F64e67c8E7B5A84b6DA534FdB0c1#code) |
| BloomFeeHook (Uniswap V4 hook) | [`0xc7279d1Dc8b3F693Af1F5C77408546F3d5AAE0CC`](https://robin.etherscan.io/address/0xc7279d1Dc8b3F693Af1F5C77408546F3d5AAE0CC#code) |
| LiquidityLocker | [`0xCbe444408d4513a828Fc1FEc41F238ec5797BBb8`](https://robin.etherscan.io/address/0xCbe444408d4513a828Fc1FEc41F238ec5797BBb8#code) |
| FeeEscrow | [`0x9A637F978e7856BEB6146a92ABA518bb9528204A`](https://robin.etherscan.io/address/0x9A637F978e7856BEB6146a92ABA518bb9528204A#code) |
| BuybackVestingVault | [`0x98cCbf00375FA1E0cD1334186acD0F52fB276B9d`](https://robin.etherscan.io/address/0x98cCbf00375FA1E0cD1334186acD0F52fB276B9d#code) |
| CanonicalBuybackAdapter | [`0x05478530278EDB9a74e4B56eFaF69d275C7B7f9A`](https://robin.etherscan.io/address/0x05478530278EDB9a74e4B56eFaF69d275C7B7f9A#code) |
| LimitOrderExecutor | [`0x8B5452bcc0c4cF64481104A820A86CCc499B8DD0`](https://robin.etherscan.io/address/0x8B5452bcc0c4cF64481104A820A86CCc499B8DD0#code) |
| BloomBuybackBurner | [`0x41957065bdd015f114fDa501d97Bf37FBDEfceeB`](https://robin.etherscan.io/address/0x41957065bdd015f114fDa501d97Bf37FBDEfceeB#code) |
| BloomBurnAdapter | [`0x4EbB4f9f6c9317040D65102623F1599CBd3DD323`](https://robin.etherscan.io/address/0x4EbB4f9f6c9317040D65102623F1599CBd3DD323#code) |
| BLOOM token | [`0x483Dba52c4A497B3a2b979D28beB26A525F7b00B`](https://robin.etherscan.io/address/0x483Dba52c4A497B3a2b979D28beB26A525F7b00B#code) |
| BLOOM curve | [`0xc81A60b2267105AfE352b3C72BbE0403d7973f07`](https://robin.etherscan.io/address/0xc81A60b2267105AfE352b3C72BbE0403d7973f07#code) |
| TeamVesting | [`0x7F3F68170476Fe5Af67273eda38bcc4a53b05226`](https://robin.etherscan.io/address/0x7F3F68170476Fe5Af67273eda38bcc4a53b05226#code) |

Full deployment record: [`config/robinhood-mainnet.deployment.json`](config/robinhood-mainnet.deployment.json).
The earlier v1 system (factory `0x4c26b5dA7BBfD8d05A2e7a682034C6842F2d6b04`) stays onchain and keeps working for its
tokens; its record is [`config/robinhood-mainnet-v1.deployment.json`](config/robinhood-mainnet-v1.deployment.json).
New launches use v2. What changed: [`docs/V2-DESIGN.md`](docs/V2-DESIGN.md).

## Contracts
| Path | Purpose |
|---|---|
| `contracts/LaunchFactory.sol` | Creates each token and its bonding curve (token addresses end in `b00b`), graduation, creator controls |
| `contracts/LaunchDeployer.sol` | CREATE2 deployment of token and curve |
| `contracts/LaunchToken.sol` | Fixed-supply ERC-20 with a claimable holder-reward ledger |
| `contracts/BondingCurve.sol` | Per-token curve: buys, sells, opening snipe protection, graduation, refunds |
| `contracts/FeeMath.sol` | 0.20% platform fee, 0–10% creator fee and its split |
| `contracts/FeeEscrow.sol` | Escrowed creator and platform fees, claimable by beneficiaries only |
| `contracts/LaunchRouter.sol` | Native-ETH router across the curve and the Uniswap V4 pool |
| `contracts/LimitOrderExecutor.sol` | Signed (EIP-712) limit orders filled by anyone |
| `contracts/BuybackVestingVault.sol` | Creator buybacks at a TWAP-bounded price, vesting over 5 years |
| `contracts/BloomBuybackBurner.sol` | Platform revenue: 50% buys and burns BLOOM, 50% to the treasury |
| `contracts/TeamVesting.sol` | Team BLOOM: 50% unlocked at launch, 50% linear over 12 months |
| `contracts/v4/BloomFeeHook.sol` | Uniswap V4 hook: fees on the quote leg and a TWAP oracle |
| `contracts/v4/LiquidityLocker.sol` | Creates the graduation pool and locks its liquidity permanently |
| `contracts/v4/CanonicalBuybackAdapter.sol` | TWAP-guarded buyback swaps on the canonical pool |
| `contracts/v2/BondingCurveV2.sol` | v2 curve: v1 economics plus Uniswap V3 pool views and `Initialize`/`Swap` events |
| `contracts/v2/LaunchFactoryV2.sol` | v2 factory: `PoolCreated` event, launch fee and minimum first buy (owner-set, capped at 0.001 ETH) |
| `contracts/v2/LaunchRouterV2.sol` | v2 router: launch = fee + first buy in one transaction |
| `contracts/v2/LaunchDeployerV2.sol` | CREATE2 deployment of token and v2 curve |
| `contracts/migration/` | Community migration of outside tokens into a BloomLaunch replacement (v1) |

Design notes: [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md), [`docs/CURVE-MATH.md`](docs/CURVE-MATH.md),
[`docs/V4-INTEGRATION.md`](docs/V4-INTEGRATION.md), [`docs/BUYBACKS.md`](docs/BUYBACKS.md).
For indexers: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Build and test
Requires Node.js 22.
```bash
npm install
npm test              # contract, Uniswap V4, deployment, migration, BLOOM, v2 and fuzz tests
npm run test:fuzz     # stateful fuzzing only; FUZZ_SEED and FUZZ_STEPS to reproduce or extend
```
Contracts compile with solc 0.8.38 (via-IR, optimizer 200 runs, Cancun). Uniswap V4 core 1.0.2 is compiled
with solc 0.8.26 for local tests against the real PoolManager.

## Security
Internal review with Slither static analysis and stateful fuzzing: [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md).
**No independent audit yet.** Tokens launched on BloomLaunch are highly speculative; nothing here is financial advice.

## License
[MIT](LICENSE)
