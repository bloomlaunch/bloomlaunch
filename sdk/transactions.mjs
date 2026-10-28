/// Client-side gas headroom for state/timestamp changes between simulation and
/// mining. This is a gas limit, not an extra fee; unused gas is not charged.
export function gasWithMargin(estimate) {
  const gas = BigInt(estimate);
  if (gas < 0n) throw new RangeError('Gas estimate must be nonnegative');
  return gas + (gas + 4n) / 5n + 30_000n;
}

/// Produces a reviewable unsigned ethers transaction. Does not sign or submit.
export async function prepareTransaction(method, args = [], overrides = {}) {
  const request = await method.populateTransaction(...args, overrides);
  const estimate = await method.estimateGas(...args, overrides);
  return { ...request, gasLimit: gasWithMargin(estimate) };
}
