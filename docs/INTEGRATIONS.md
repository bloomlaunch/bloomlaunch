# BloomLaunch: integration guide for market-data providers

For DexScreener, GeckoTerminal, Codex, DEXTools and similar indexers. Everything below is public onchain data;
all contracts are source-verified on Etherscan, Blockscout and Sourcify.

## Project
| | |
|---|---|
| Name | BloomLaunch |
| Type | Token launchpad: bonding curve, then automatic graduation to a locked Uniswap V4 pool |
| Website | https://bloomlaunch.fun |
| Logo | https://bloomlaunch.fun/icon-512.png (512×512 PNG), https://bloomlaunch.fun/bloom.svg |
| Chain | Robinhood Chain mainnet, chain ID **4663** |
| RPC | https://rpc.mainnet.chain.robinhood.com |
| Explorers | https://robin.etherscan.io, https://robinhoodchain.blockscout.com |
| Deployed from block | **100177125** (28 Oct 2026) |
| Platform token | BLOOM `0xBdF115C7e3aB044B7272F72dAad5Fd7FC895B00B` |
| X | https://x.com/bloomlaunch |
| Source code | https://github.com/bloomlaunch/bloomlaunch |
| Contact | https://bloomlaunch.fun/#/builders (integration form) |

## Contracts
| Contract | Address | Role |
|---|---|---|
| LaunchFactory | `0x4c26b5dA7BBfD8d05A2e7a682034C6842F2d6b04` | Creates every token and its bonding curve; emits launches and graduations |
| LaunchRouter | `0xBA99f5E8391125Cc58D81569FD8d4Cdf2618473D` | User entry point for buys and sells on the curve or the pool |
| BloomFeeHook | `0xd4fF3e6982525b9cD8C1F286FbD62ef95F67e0CC` | Uniswap V4 hook on every graduated pool |
| LiquidityLocker | `0x7Cd89B0255410DA177B8d9cCCAAFb3250061E2C9` | Creates the V4 pool at graduation and locks its liquidity permanently |
| Uniswap V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Canonical Robinhood Chain V4 PoolManager |
| WETH (quote asset) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | Every launch is currently paired with ETH |

## Tokens
- Standard ERC-20, **18 decimals**, fixed supply **1,000,000,000** (`1e27` base units). No mint, tax, blacklist or pause.
- Every BloomLaunch token address ends in **`b00b`** (vanity suffix enforced by the factory).
- Name, symbol and supply: standard `name()`, `symbol()`, `totalSupply()`.

## Lifecycle
1. **Launch:** the factory deploys the token and a per-token **BondingCurve** contract (the "pair" while on the curve).
2. **Curve trading:** buys and sells happen against the curve contract.
3. **Graduation:** the buy that completes the curve releases its reserves to the LiquidityLocker, which creates a
   **Uniswap V4 pool** (LP fee 0, tick spacing 200, hook BloomFeeHook) with permanently locked full-range liquidity.
4. **Pool trading:** standard Uniswap V4 swaps on that pool.

## Events to index

### New tokens: LaunchFactory `0x4c26b5dA7BBfD8d05A2e7a682034C6842F2d6b04`
```
event TokenLaunched(address indexed token, address indexed curve, address indexed creator, address quote, uint256 configId)
topic0 0x2caa4aa609b0b535621db8389bd14bcffb5c2ab47882c20f97e63a41381803c8
```
`curve` is the bonding-curve contract to track for this token; `quote` is the pair asset (WETH).

### Curve trades: emitted by each token's BondingCurve (the `curve` from TokenLaunched)
```
event Trade(address indexed trader, address indexed recipient, bool buy, uint256 tokens, uint256 grossQuote, uint256 platformFee, uint256 creatorFee)
topic0 0x9adcf0ad0cda63c4d50f26a48925cf6405df27d422a39c456b5f03f661c82982
```
- `buy = true`: `recipient` received `tokens` for `grossQuote` WETH (wei). `buy = false`: tokens were sold for `grossQuote`
  before fees.
- Trade price in ETH per token = `grossQuote / tokens` (both 18 decimals).
- Fees are inside `grossQuote`: `platformFee` (0.20%) + `creatorFee` (0–10%, fixed per token).
- `trader` is the caller, usually the LaunchRouter or LimitOrderExecutor; `recipient` is the wallet receiving the tokens or proceeds.
  For "maker" attribution use `recipient`, or the `trader` field of the router's RoutedTrade event below.

### Graduation: LaunchFactory
```
event Graduated(address indexed token, bytes32 indexed poolId)
topic0 0xfbf67b106a3384ccd21d69e049cb8487d547a01fe9120407840d191b4577e5ed
```
After this, the token trades only in the Uniswap V4 pool `poolId`. Pool key: currencies sorted (token, WETH), `fee = 0`,
`tickSpacing = 200`, `hooks = 0xd4fF3e6982525b9cD8C1F286FbD62ef95F67e0CC`. Standard PoolManager `Initialize` and `Swap`
events apply. The hook charges the platform and creator fees on the WETH leg; PoolManager `Swap` amounts exclude them.
The per-swap fee breakdown is in:
```
event PoolFees(address indexed token, address indexed trader, uint256 platformFee, uint256 creatorFee, uint256 holderRewards, uint256 buybackFunding, uint256 creatorEarnings)
topic0 0x3c416f7bbb3db373893f782e2487d7817574909497fe6d5040cda531fe9224f6   (emitted by BloomFeeHook)
```

### Optional: user-level trades across curve and pool, LaunchRouter `0xBA99f5E8391125Cc58D81569FD8d4Cdf2618473D`
```
event RoutedTrade(address indexed token, address indexed trader, address indexed recipient, bool buy, bool viaPool, uint256 quoteAmount, uint256 tokenAmount)
topic0 0x347404b6df6f555379b63d387b5e15cf4141cad993209437bff1b71f11c27e88
```

### Other events
| Contract | Event | topic0 |
|---|---|---|
| BondingCurve | `PhaseChanged(uint8 phase)` (0 uninitialized, 1 curve, 2 graduation pending, 3 pool, 4 refunded) | `0xa6dcc92f45df25789d5639b7a0c97ba1edf3bb1c0b5dd3376fd96a0db87c4642` |
| LiquidityLocker | `LiquidityLocked(address indexed token, bytes32 indexed poolId, uint128 liquidity, uint160 sqrtPriceX96, uint256 tokenAmount, uint256 quoteAmount)` | `0xa5cda5bf93915991f5f57a3e851a5986db28dd425343078a83a034e59d4fefea` |
| LaunchFactory | `CreatorTransferred(address indexed token, address indexed previousRecipient, address indexed nextRecipient)` | `0xf51df37c442fa56bb69ae31113b6baba4153182940542bc965ee52d668e2e7ea` |

## Price, liquidity and market cap while on the curve
Read from the token's BondingCurve:
- `quoteReserve()`: virtual + real WETH reserve. `tokenReserve()`: virtual token reserve.
- **Spot price (ETH per token) = `quoteReserve() / tokenReserve()`.** At launch this is `1.3125e-9` ETH per token.
- **Market cap = spot price × 1,000,000,000.** It starts at about 1.31 ETH, and graduation happens after about 4.2 ETH is raised.
- **Real liquidity (ETH actually held) = `realQuoteReserve()`**; the rest of `quoteReserve()` is virtual.
- `phase()`: `1` = trading on the curve, `3` = graduated (use the V4 pool from then on).
- Quotes: `quoteBuy(uint256 maxGross)` and `quoteSell(uint256 tokens)` return the exact amounts and fees.

## Token metadata (description, image, socials)
`LaunchFactory.launches(token)` returns `metadataURI` in the form `bloom-meta:<sha256>`. Resolve it with:
```
https://bloomlaunch.fun/api/metadata/<sha256>          -> JSON { description, image, website, x, telegram, discord }
https://bloomlaunch.fun/api/metadata/<image file>      -> the image (PNG/JPEG/WebP/GIF, at most 20 KB)
```
Files are content-addressed (the name is the SHA-256 of the content), so they never change.

## Public read API (convenience, rate limited)
| Endpoint | Returns |
|---|---|
| `GET https://bloomlaunch.fun/api/launches?paged=1&limit=100&offset=0` | All launches with price, market cap (ETH), progress, holders |
| `GET https://bloomlaunch.fun/api/launches/<token>` | One launch, including curve address and metadata |
| `GET https://bloomlaunch.fun/api/launches/<token>/trades?limit=200` | Recent trades |
| `GET https://bloomlaunch.fun/api/launches/<token>/candles?interval=300` | OHLC candles (interval in seconds, 60 to 86400) |
| `GET https://bloomlaunch.fun/api/launches/<token>/holders` | Holder balances |

Example token: Useful Coin `0x7eC01AA94BDF1F94d94A532Fc4d549390b77B00b`, curve `0x85eB77A7cfd625FB8626e1A5caB9f3607f25c28b`.
