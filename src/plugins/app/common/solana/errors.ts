export type SolanaErrorLike = Error & {
  context?: { __code?: number | string; statusCode?: number };
  cause?: unknown;
};

export function collectSolanaErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const ctx = (current as SolanaErrorLike).context;
    if (ctx?.__code !== undefined) {
      codes.push(String(ctx.__code));
    }
    current = (current as SolanaErrorLike).cause;
  }
  return codes;
}
