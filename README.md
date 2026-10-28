# BloomLaunch contracts

Smart contracts for [BloomLaunch](https://bloomlaunch.fun), the token launchpad on Robinhood Chain.
Gas-only launches, a bonding curve that graduates automatically into a permanently locked Uniswap V4
pool, a fixed 0.20% platform fee per trade, and a 0–10% creator fee the creator can share with holders
and buybacks. Half of platform revenue buys and burns BLOOM, the platform token.

[Website](https://bloomlaunch.fun) · [Developer docs](https://bloomlaunch.fun/#/docs) · [X](https://x.com/bloomlaunch)

## Deployed on Robinhood Chain mainnet (chain 4663)
Source-verified on [Etherscan](https://robin.etherscan.io), [Blockscout](https://robinhoodchain.blockscout.com) and Sourcify.

| Contract | Address |
|---|---|
| LaunchFactory | [`0x4c26b5dA7BBfD8d05A2e7a682034C6842F2d6b04`](https://robin.etherscan.io/address/0x4c26b5dA7BBfD8d05A2e7a682034C6842F2d6b04#code) |
| LaunchRouter | [`0xBA99f5E8391125Cc58D81569FD8d4Cdf2618473D`](https://robin.etherscan.io/address/0xBA99f5E8391125Cc58D81569FD8d4Cdf2618473D#code) |
| BloomFeeHook (Uniswap V4 hook) | [`0xd4fF3e6982525b9cD8C1F286FbD62ef95F67e0CC`](https://robin.etherscan.io/address/0xd4fF3e6982525b9cD8C1F286FbD62ef95F67e0CC#code) |
| LiquidityLocker | [`0x7Cd89B0255410DA177B8d9cCCAAFb3250061E2C9`](https://robin.etherscan.io/address/0x7Cd89B0255410DA177B8d9cCCAAFb3250061E2C9#code) |
| FeeEscrow | [`0xBBe04bFA997f1c80B8162ae6E1D4b9d3b3296400`](https://robin.etherscan.io/address/0xBBe04bFA997f1c80B8162ae6E1D4b9d3b3296400#code) |
| BuybackVestingVault | [`0x45106872b07ba18AE79a91049DFEB4169D80e118`](https://robin.etherscan.io/address/0x45106872b07ba18AE79a91049DFEB4169D80e118#code) |
| LimitOrderExecutor | [`0x6A1b9516d5A2c985C8f92e2F4Bc5c186056515eE`](https://robin.etherscan.io/address/0x6A1b9516d5A2c985C8f92e2F4Bc5c186056515eE#code) |
| MigrationFactory | [`0x6799eEc66f8E2F75aD5893422c747b97f68452C4`](https://robin.etherscan.io/address/0x6799eEc66f8E2F75aD5893422c747b97f68452C4#code) |
| BloomBuybackBurner | [`0x8F0911BeFD99bbb0EF3868780DCdF41CfCfA3E97`](https://robin.etherscan.io/address/0x8F0911BeFD99bbb0EF3868780DCdF41CfCfA3E97#code) |
| BLOOM token | [`0xBdF115C7e3aB044B7272F72dAad5Fd7FC895B00B`](https://robin.etherscan.io/address/0xBdF115C7e3aB044B7272F72dAad5Fd7FC895B00B#code) |
| TeamVesting | [`0xA9d436aF7c69634DFb591b0BC25505b2034D516d`](https://robin.etherscan.io/address/0xA9d436aF7c69634DFb591b0BC25505b2034D516d#code) |

Full deployment record: [`config/robinhood-mainnet.deployment.json`](config/robinhood-mainnet.deployment.json).

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
| `contracts/migration/` | Community migration of outside tokens into a BloomLaunch replacement |

Design notes: [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md), [`docs/CURVE-MATH.md`](docs/CURVE-MATH.md),
[`docs/V4-INTEGRATION.md`](docs/V4-INTEGRATION.md), [`docs/BUYBACKS.md`](docs/BUYBACKS.md).
For indexers: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

## Build and test
Requires Node.js 22.
```bash
npm install
npm test              # contract, Uniswap V4, deployment, migration, BLOOM and fuzz tests
npm run test:fuzz     # stateful fuzzing only; FUZZ_SEED and FUZZ_STEPS to reproduce or extend
```
Contracts compile with solc 0.8.38 (via-IR, optimizer 200 runs, Cancun). Uniswap V4 core 1.0.2 is compiled
with solc 0.8.26 for local tests against the real PoolManager.

## Security
Internal review with Slither static analysis and stateful fuzzing: [`docs/SECURITY-REVIEW.md`](docs/SECURITY-REVIEW.md).
**No independent audit yet.** Tokens launched on BloomLaunch are highly speculative; nothing here is financial advice.

## License
[MIT](LICENSE)
