# Creator buybacks and vesting

The creator can allocate part of their fee to buybacks at launch. The platform's
20 basis point fee and the holder allocation are unaffected. Allocation rates
remain fixed; the creator can toggle execution funding on or off. While disabled,
the buyback portion of new creator fees goes to the creator's claimable earnings.
Governance can disable buybacks, but cannot enable them in its governance role.

## Custody and identity

BuybackVestingVault binds its factory once. The bootstrapper cannot rebind the
factory or change the adapter, beneficiaries or five-year vesting duration later.
Only a factory-recognized fee source may deposit. Deposits must match the launch's
quote asset and current creator recipient, and must be backed by exactly the
received ERC-20 amount. Native-asset deployments use wrapped native currency here.

Unspent quote funding is accounted for by token and beneficiary. Takeovers move
future fee rights; they do not move old funding or vesting lots. A previous creator
can withdraw their unused funding. The current creator can withdraw unused funding
after disabling optional buybacks. The vault has no owner sweep or arbitrary fund
withdrawal path. Transfers sent directly to the vault are not credited deposits.

## Execution boundary

Anyone may pay gas to execute a buyback. They choose an amount from one funded
position, but cannot choose the swap route, token recipient or vesting terms.
The immutable adapter supplies minimum received tokens and maximum input from its
market policy. A successful call must spend exactly the approved quote amount and
deliver at least the minimum tokens directly to the vault. Approval is limited to
that amount and cleared on success. Failures roll back balances, approvals,
cooldowns and vesting state. Executions have a 60-second per-token cooldown and a
deadline no more than five minutes ahead.

The production canonical-market adapter is still required. It must enforce real
time-weighted observation freshness, price-impact limits, canonical route identity
and nonrecursive internal fee allocation. The vault does not itself construct a
price oracle. A malicious or incorrectly implemented adapter can misprice a swap
within its own fabricated limits; code review and real market integration are
therefore required. MockBuybackAdapter is test-only and must never be deployed as
the production adapter.

## Vesting and claims

Each purchase creates a separate linear vesting lot lasting 5 × 365 days from its
own execution timestamp, with no cliff. A later purchase cannot inherit an older
purchase's elapsed vesting time. All bought tokens belong to that lot's beneficiary;
none are allocated to the platform. Existing rights remain with the old beneficiary
when creator rights transfer.

Claims accept a start index and count, with at most 100 lots per transaction. No
transaction loops over all lots or all creators. Anyone can trigger a payment to
the beneficiary; only that beneficiary may redirect the payment to another address.
Repeated claims pay only newly vested amounts. Separate quote and token liability
totals allow custody reconciliation without treating direct donations as revenue.

## Client transaction preparation

Use `sdk/transactions.mjs` to prepare unsigned transactions with gas headroom. A
fresh lot can become claimable between estimation and mining, causing extra storage
writes and token-transfer accounting. The initial exact-estimate claim exhausted
gas inside the launch token's transfer; a traced run ended in its storage write,
then propagated an empty revert through the safe transfer. Adding headroom allowed
the unchanged contract logic to execute the complete vesting scenario.

The helper adds 20% plus 30,000 gas to the estimate. This is a gas limit, not a
protocol fee; unused gas is not charged. It is not a guarantee against all state
changes. The application must still simulate, show the user's minimum received
amount, preserve deadlines, and surface transaction failures clearly.
