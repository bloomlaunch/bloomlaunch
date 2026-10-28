# Curve economics implemented for testing

This is the current constant-product model, not final mainnet economic approval.
No curve parameter changes the fixed 20 basis point platform trading fee.

Let T be actual total token supply, L the real token inventory reserved for the
graduated pool, P the virtual quote reserve, and V the virtual token reserve.
Require 0 < L < T/2 and define V = floor(L² / (T − 2L)).

Initial pricing reserves are x = T + V and y = P. Real quote reserves start at
zero. There is no collateral or platform launch fee required for creation.

On a buy, fees are subtracted from gross quote input. For net input q, the curve
outputs floor(xq / (y + q)) tokens. It updates x by subtracting the delivered
tokens, and real quote reserves by adding q. The virtual reserves remain pricing
terms only; the contract cannot withdraw imaginary quote assets.

On a sell of t tokens, gross quote output is floor(yt / (x + t)). Fees are
subtracted from this gross output; only the resulting net amount reaches the
seller. The whole gross output is removed from real quote reserves.

Ignoring integer rounding, selling the full curve inventory leaves x = L + V
and collects real quote R = P(T − L)/(L + V). The curve's terminal marginal
price is (P + R)/(L + V), while the pool's opening spot is R/L.
Equality gives V(T − 2L) = L², which is the calibration used above.

Prototype test configuration:

- T = 1,000,000,000 tokens with 18 decimals.
- L = 200,000,000 tokens.
- V ≈ 66,666,666.666666666666666666 virtual tokens.
- P = 1.4 quote units when quote decimals are 18.
- Implied real quote at graduation ≈ 4.2 quote units.

Custom quote assets need their own decimal-scaled P configuration; 1.4 units of
a stablecoin and 1.4 ETH are different economics. Reserve settings are snapshotted
on each launch. Administrators can disable a configuration for future launches
but cannot change an existing token's curve settings.

The final buy is capped to remaining curve inventory. The contract computes the
minimum gross input that covers the required net input after separately rounded
platform and creator fees. It pulls only the consumed amount, leaving the rest
in the trader's wallet. Minimum output and deadline checks still apply.

Rounding never creates output assets: buy output and sell gross output round down;
required net input for the final buy rounds up. Repeated trades can accumulate
rounding dust. Graduation integration must check the resulting actual pool price
against the terminal curve price rather than relying on this symbolic derivation
alone. Tests compare actual reserve ratios with a one-basis-point tolerance.

Donated token or quote balances are not automatically added to pricing reserves.
Neither donations nor protocol fee balances can manufacture graduation progress.

If pool creation fails, reserves remain in GraduationPending and pool creation can
be retried permissionlessly. After seven days, anyone may activate permanent
recovery; outstanding token holders redeem pro rata from remaining real quote
reserves. The original trading fees are not refunded. Recovery charges no new
platform fee. Locked pool liquidity is outside this recovery path.
