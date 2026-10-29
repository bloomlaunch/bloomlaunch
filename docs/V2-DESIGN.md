# BloomLaunch v2: bonding curves that market-data sites detect automatically

Status (29 Oct 2026): built and tested; deployed and checked end to end on Robinhood Chain testnet
(`deployments/46630-v2.json`). Mainnet deploy: `npm run deploy:mainnet:v2` (run by the deployer).

## Goal
Every BloomLaunch token should appear on DexScreener (and providers that work the same way, such as
GeckoTerminal and Codex) **from its first trade**, with a live chart, without applying for an integration.
Today, tokens only appear after graduation, when they trade in the Uniswap V4 pool.

## What the providers detect (measured on Robinhood Chain mainnet)
DexScreener lists several exchanges on Robinhood Chain by raw factory address, which means it found them
on its own. They include launchpad pools that trade PONS, BONER and CASHCAT. On-chain inspection:

| Contract | Interface | Events seen |
|---|---|---|
| Factory `0x9a8442cb…97EcF` | Uniswap V3-style factory | `PoolCreated(address,address,uint24,int24,address)` |
| Pool PONS/WETH `0xB9AD5b…82aD8` | `token0`, `token1`, `factory`, `fee`, `slot0` | `Swap(address,address,int256,int256,uint160,uint128,int24)` (V3) |
| Factory `0x5481864d…2E5E3` | owner only; no events in the last ~4M blocks | none |
| Pool BONER/USDG `0x50eb83…7e71B` (45-byte clone) | `token0`, `token1`, `factory`, `fee` | V3 `Swap` (351), `Mint`, `Burn`, `Collect` |

Conclusion: a contract is picked up when it **behaves like a Uniswap V3 pool**: it emits the standard V3
`Swap` event and answers the V3 pool read functions. A factory `PoolCreated` event helps but is not required.
The v1 `BondingCurve` emits its own `Trade` event and has none of these functions, so it is invisible until
graduation.

## The v2 change, in one sentence
The v2 `BondingCurve` keeps exactly the v1 economics and safety, and additionally **presents itself as a
Uniswap V3 pool** between the token and WETH: standard read functions plus a standard `Swap` event on every
buy and sell, priced from the curve's real reserves.

### Interface added to the curve (read-only views)
| Function | v2 value |
|---|---|
| `token0()`, `token1()` | The token and WETH, sorted by address (as Uniswap does) |
| `factory()` | The v2 `LaunchFactory` (providers group pools by this; it becomes the "exchange") |
| `fee()` | Total trading fee in hundredths of a basis point: 0.20% platform + creator fee (1% creator → `12000`) |
| `tickSpacing()` | `1` |
| `slot0()` | `(sqrtPriceX96, tick, 0, 0, 0, 0, true)` from the live curve price |
| `liquidity()` | `sqrt(virtualQuote × virtualTokens)` while on the curve; **`0` after graduation**, so providers prefer the V4 pool |

The curve is a constant-product market on virtual reserves (`tokensOut = tokenReserve × net / (quoteReserve + net)`),
which is exactly what a full-range V3 position is. So these values describe the real market, not an approximation.

### Events added
| When | Event | Values |
|---|---|---|
| Curve initialised | `Initialize(uint160 sqrtPriceX96, int24 tick)` | Opening price |
| Every buy / sell | `Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)` | Pool-perspective amounts: positive = into the curve (gross WETH including fees on buys; tokens on sells), negative = out. Price, liquidity and tick **after** the trade |
| Launch (factory) | `PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)` | `pool` = the curve |

The v1 `Trade` event stays too, so our indexer and anyone integrated with v1 keep working.

### Price maths (on-chain, cheap)
- `price(token1 per token0) = reserve1 / reserve0` using the curve's **virtual** reserves (`quoteReserve()`, `tokenReserve()`),
  the same spot price the curve quotes.
- `sqrtPriceX96 = sqrt(mulDiv(reserve1, 2^192, reserve0))` (512-bit `mulDiv`, no overflow for any curve state).
- `tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96)` (Uniswap v4-core library we already use).
- Extra gas per trade: roughly 5–10k for the square root, tick lookup and event. That's small next to a trade.

## What stays the same
- Fees: 0.20% platform + 0–10% creator fee, holder rewards, buybacks, snipe protection, graduation guard,
  locked Uniswap V4 pool, …b00b addresses, refunds. Same maths, same tests.
- **BLOOM is relaunched on v2** with its own burner and team vesting (100M reserve: 50M unlocked, 50M vesting 12 months).
  The v1 BLOOM and v1 coins stay onchain and keep working; the website shows v2 only.
- v1 tokens keep working forever on v1 contracts; nothing migrates.

## Contracts in a v2 deployment
Every launch-path contract is bound once to its factory, so v2 is a fresh set:

| Contract | Change |
|---|---|
| `BondingCurve` | **New:** V3 pool interface + events (above) |
| `LaunchFactory` | **Small:** emits `PoolCreated` at launch; launches only through the router; `setLaunchTerms(fee, minInitialBuy)` (owner, each capped at 0.001 ETH) |
| `LaunchDeployer` | Rebuilt (new curve bytecode) |
| `LaunchRouter` | **Small:** `launch` charges the launch fee (to platform revenue, so 50% BLOOM burn / 50% treasury) and requires a first buy of at least `minInitialBuy`; ETH pairs only |
| `LimitOrderExecutor`, `FeeEscrow`, `BuybackVestingVault`, `CanonicalBuybackAdapter`, `LiquidityLocker`, `BloomFeeHook` | Same code, redeployed (bound to the v2 factory) |
| `BloomBuybackBurner`, BLOOM, `TeamVesting` | Redeployed: v2 platform revenue buys and burns the v2 BLOOM |
| `MigrationFactory` | Not deployed on v2 yet (v1 `Migration` calls the removed public `launch`) |

Also fold in the open item from the security review: **migration sales priced against the 30-minute TWAP**
(or keeper-only), fixing the sandwich exposure.

## Off-chain changes (done)
- **Website, indexer, keeper:** point at the v2 deployment only (v1 coins no longer listed). ABIs come from the v2 contracts.
- **Launch form:** shows the launch fee and total; first buy defaults to, and must be at least, the minimum.
- **Agent API / MCP:** the separate off-chain $0.10 payment is gone; the launch transaction's value is fee + first buy.
- **Docs, llms.txt:** launch cost and V3-compatible events.
- **Verification:** Etherscan, Sourcify and Blockscout for all v2 contracts (scripts exist).

## Validation plan (before mainnet)
1. **Unit and fuzz tests** for the new curve: every `Swap` event's amounts, price and tick match the trade and the
   curve state; `slot0`/`liquidity` agree with `quoteReserve`/`tokenReserve`; both token orderings; graduation zeroes
   `liquidity()`. Rerun the full v1 suite and fuzzer against v2.
2. **Event-format check against real Uniswap V3:** decode our events with the standard Uniswap V3 pool ABI and
   compare to a real V3 pool's events on Robinhood Chain.
3. **Testnet end to end** with `node scripts/testnet-check.mjs --v2` (then `--v2 --phase2` after 30 minutes). Done: all checks pass.
4. **Mainnet detection pilot (cheap, honest):** deploy v2, launch one clearly-named test token, make a few real
   tiny trades, and confirm it appears on DexScreener (and check GeckoTerminal/Codex). DexScreener does not index
   testnet, so this is the only definitive check. Cost: deployment gas (~0.0006 ETH) plus a few cents of trades.
5. **External audit** of the v2 contracts together with v1 (one engagement), before promoting v2 publicly.

## Effort (rough)
| Part | Time |
|---|---|
| Contracts + tests (curve interface/events, factory event, forwarder, migration TWAP) | 1–2 days |
| Indexer, website, agent API, keeper multi-version | 1–2 days |
| Testnet, mainnet pilot, verification | ½ day |

## Risks and notes
- Providers could change detection rules; the measured behaviour is today's. The integration route
  (DexScreener request, Codex) stays available as a backup.
- Until named by the provider, v2 pools show under the factory address (as `0x9a84…` does today); providers usually
  add a name once there's volume.
- Two pairs per token after graduation (the finished curve and the V4 pool): `liquidity() = 0` on the curve steers
  providers to the V4 pool.
- v2 is a new deployment with new addresses; the governor (or the Safe, if activated) owns it.
