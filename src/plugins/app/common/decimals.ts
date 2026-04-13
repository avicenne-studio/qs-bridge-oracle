/** wQUBIC on Solana has 9 decimals; QU on Qubic has none. */
export const WQUBIC_DECIMALS_FACTOR = 1_000_000_000n;

/** Convert QU (Qubic, no decimals) to raw wQUBIC (Solana, 9 decimals). */
export function quToRawWqubic(qu: bigint): bigint {
  return qu * WQUBIC_DECIMALS_FACTOR;
}

/** Convert raw wQUBIC (Solana, 9 decimals) to QU (Qubic, no decimals). */
export function rawWqubicToQu(raw: bigint): bigint {
  return raw / WQUBIC_DECIMALS_FACTOR;
}
