/**
 * Computes the number of oracle signatures required to mark an order ready.
 *
 * Accepts two formats for signatureThreshold:
 *   - Ratio  (0 < x <= 1): required = ceil(oracleCount * x)
 *   - Integer (x > 1):     required = floor(x)
 *
 * Always returns at least 1.
 */
export function computeRequiredSignatures(
  signatureThreshold: number,
  oracleCount: number,
): number {
  const threshold = Math.max(0, signatureThreshold);
  const total = Math.max(1, oracleCount);
  if (threshold > 0 && threshold <= 1) {
    return Math.max(1, Math.ceil(total * threshold));
  }
  return Math.max(1, Math.floor(threshold));
}
