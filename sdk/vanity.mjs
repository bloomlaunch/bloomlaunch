// Finds a token salt whose CREATE2 address ends in the factory's required suffix
// (hex b00b). Pure computation; works in Node and browsers.
import { concat, getBytes, hexlify, keccak256 } from 'ethers';

export const TOKEN_SUFFIX = 0xb00bn;
export const TOKEN_SUFFIX_MASK = 0xffffn;

/// `onProgress(tries)` is called periodically; `yieldEvery` lets browsers stay responsive.
export async function mineTokenSalt(deployer, initHash, { start, onProgress, yieldEvery = 4096 } = {}) {
  const prefix = getBytes(concat(['0xff', deployer]));
  const hash = getBytes(initHash);
  const buffer = new Uint8Array(85);
  buffer.set(prefix, 0);
  buffer.set(hash, 53);
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  if (start != null) salt.set(getBytes('0x' + BigInt(start).toString(16).padStart(64, '0')));
  for (let tries = 1; ; tries++) {
    // Increment the last 8 bytes as a counter.
    for (let i = 31; i >= 24; i--) { salt[i] = (salt[i] + 1) & 0xff; if (salt[i] !== 0) break; }
    buffer.set(salt, 21);
    const digest = keccak256(buffer);
    // Address is the last 20 bytes; the suffix is its last 2 bytes (4 hex chars).
    if (digest.endsWith('b00b')) return { salt: hexlify(salt), tries };
    if (tries % yieldEvery === 0) { onProgress?.(tries); await new Promise(r => setTimeout(r, 0)); }
  }
}
