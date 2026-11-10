# BloomLaunch on Elysium

Status (10 Nov 2026): in progress. BloomLaunch moves from Robinhood Chain to Elysium (Kinetiq's Arbitrum Orbit
L2 for Hyperliquid: chain 99901, HYPE as gas, 100 ms blocks). The Robinhood contracts stay onchain (git tag
`robinhood-v2`); the site will show Elysium only.

## Decisions
| Topic | Decision |
|---|---|
| Launch | Free (gas only). Every launch includes a small first buy, at least ~$0.05 of HYPE, so the coin charts at once |
| Platform fee | 0.10% per trade (was 0.20%), plus the creator's fixed 0-10% |
| BLOOM | Relaunched on Elysium. 20% of supply to the team wallet at launch, unlocked; 80% sold on its curve. Platform fees buy it back and burn half (treasury keeps half). No vesting contract |
| Upgrades | Behind UUPS proxies: factory, router, fee escrow, buyback vault, buyback adapters, limit-order executor, BLOOM burner. **Never upgradeable:** each coin's token and curve, the liquidity locker (graduated liquidity stays locked forever) and the V4 fee hook (pool fees can never change). Upgrade rights follow the factory owner |
| Wallets | Deployer, governor (owner, upgrades) and the team's 20% BLOOM: `0x44386D1C649933d97D0F586Bbb05C301e5223A78`. **Fee earnings only** (treasury half of platform fees, agent service fees): `0x8c56f99D5c72D8F6c91EFcC903C61eFFA9e062E4` |
| Agents | Launch free on-chain; the agent service still charges $0.10 in HYPE |
| RPC | Alchemy (key on the server only) with the public RPC as fallback |
| Look | Elysium palette: deep teal-navy background, cyan accent, teal gradient buttons, DM Sans |

## Elysium dependencies (checked onchain 10 Nov 2026)
| | Mainnet 99901 | Testnet 99801 |
|---|---|---|
| Uniswap V4 PoolManager | `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1` (24,009 bytes) | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| WHYPE | `0xbA876237B0F021A6c6D852d6c26E107997cC5E81` | to confirm |
| USDC | `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` | |
| Explorer | elysium.kinetiq.xyz/explorer | elysium.kinetiq.xyz/testnet-explorer |
| DexScreener chain id | `elysium` | |

Live HYPE/USD: deepest WHYPE/USDC pools are Aerodrome-style `0x97796D80b6A1db78632f7451196b04f307329EB6` and Ramses V3
`0xD329b88BA62483918c3F6c9421178345cF9EEBc2`. HyperCore market data arrives through a precompile about four weeks
after mainnet and can replace the pool read.

## Measured on a fork of Elysium mainnet (10 Nov 2026)
Full deploy (system, proxies, BLOOM, BridgeOut): 45+ transactions, ~31M gas: ~0.016 HYPE at Elysium's 0.5 gwei base fee
(~0.045 HYPE even at 1.44 gwei). Then: a free launch with the 0.00068 HYPE first buy opened at 41.25 HYPE (~$3,035);
graduation after 132.5 HYPE raised into the real V4 PoolManager with the pool locked; pool trades through the 0.10% hook;
platform revenue split to the fee wallet and BLOOM bought and burned. Run it again with `npm run dryrun:elysium`.

## Proxy conversion
1. Deploy each upgradeable contract's proxy (ERC1967, UUPS) pointing at a minimal bootstrap implementation, so every
   permanent address is known first. The locker is deployed directly and the hook by CREATE2 at an address with the
   right V4 permission bits (both immutable).
2. Deploy the real implementations with those addresses as constructor immutables (external constants such as
   the PoolManager and WHYPE stay immutables too).
3. `upgradeToAndCall` each proxy to its implementation with `initialize(...)`; constructor-set state moves there.
4. `_authorizeUpgrade` checks the factory owner, so moving factory ownership to a Safe or timelock moves every
   upgrade right with it.
Trust note for the docs: upgradeable core means holders trust the owner not to upgrade maliciously. A timelock
(e.g. 48 h) before upgrades is the recommended next step.

## Bridge with a fee (HyperEVM <-> Elysium)
Elysium's own bridge moves native HYPE 1:1 as plain value (deposits in about a minute; withdrawals claimable on
HyperEVM after the ~5.5 day challenge period) and ERC-20s through gateway routers
(HyperEVM `0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0`, Elysium `0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17`).

A BloomLaunch bridge is a thin, non-custodial wrapper that takes a fee and calls the official bridge in the same
transaction:
- **Deposit contract on HyperEVM (999):** `depositHYPE(to)` keeps the fee and creates a retryable ticket to `to` on
  Elysium through the Inbox (`0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff`). A plain `depositEth` from a contract would
  credit the contract's aliased address, so the ticket form is required. `depositToken(token, amount, to)` takes the
  fee, approves the token's gateway and calls `outboundTransfer` with HYPE for delivery.
- **Withdraw contract on Elysium:** `withdrawHYPE(to)` keeps the fee and calls ArbSys `withdrawEth(to)`;
  `withdrawToken` burns through the Elysium router. The site then needs a "claim" step on HyperEVM after the
  challenge period (Outbox `executeTransaction` with a proof from NodeInterface).
- **Fee:** 0.1% of the amount bridged (owner's decision), paid to the fee wallet 0x8c56...62E4, capped in the contract and shown before signing.
- The official bridge stays free apart from gas, so the fee pays for convenience (one page with the launchpad).
Effort: two small contracts on two chains plus a bridge page with a withdrawal tracker and claim button.

## Bigger opportunity: graduate coins to HyperCore
Elysium tokens can be mirrored to HyperEVM (permissionless mirror bridge) and then listed on HyperCore's spot order
book (one-time spot deployment: buys the ticker and links a deposit wallet). A "graduate to Hyperliquid" path for
successful coins is a strong feature to plan after launch.

## Order of work
1. Contracts: fee, BLOOM share, free launch (done in code); proxy conversion; tests and fuzz.
2. No testnet (owner's decision): a full dry run against a local fork of Elysium mainnet (real WHYPE and Uniswap V4 state, no funds spent), then mainnet.
3. Site, indexer, keeper and agent API on Elysium; HYPE price from the pool; Elysium colors.
4. Mainnet deploy (the owner runs it with the hidden key prompt), verification on the Elysium explorer.
5. Bridge contracts and page.
