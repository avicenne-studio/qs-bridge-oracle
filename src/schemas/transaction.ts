import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "./common.js";
import {
  QubicTransactionSchema,
  QubicTransaction,
} from "./qubic-transaction.js";
import {
  SolanaTransactionSchema,
  SolanaTransaction,
} from "./solana-transaction.js";

export const OracleChain = Type.Union([
  Type.Literal("qubic"),
  Type.Literal("solana"),
]);

export const OracleTransactionSchema = Type.Object({
  source: OracleChain,
  dest: OracleChain,
  from: StringSchema,
  to: StringSchema,
  amount: Type.Number(),
  raw: Type.Union([QubicTransactionSchema, SolanaTransactionSchema]),
});

export type OracleTransaction = Static<typeof OracleTransactionSchema>;

export function assertValidOracleTransaction(o: OracleTransaction) {
  if (o.source === o.dest) {
    throw new Error("OracleTransaction: source and dest must differ");
  }
}

export function trxFromQubic(
  tx: QubicTransaction,
  dest: Static<typeof OracleChain>
): OracleTransaction {
  const o: OracleTransaction = {
    source: "qubic",
    dest,
    from: tx.sender,
    to: tx.recipient,
    amount: tx.amount,
    raw: tx,
  };
  assertValidOracleTransaction(o);
  return o;
}

export function trxFromSolana(
  tx: SolanaTransaction,
  dest: Static<typeof OracleChain>
): OracleTransaction {
  const ix = tx.instructions[0];
  const decoded = decodeBridgeInstruction(ix.data);
  const o: OracleTransaction = {
    source: "solana",
    dest,
    from: decoded.from,
    to: decoded.to,
    amount: decoded.amount,
    raw: tx,
  };
  assertValidOracleTransaction(o);
  return o;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function decodeBridgeInstruction(_data: string): {
  from: string;
  to: string;
  amount: number;
} {
  throw new Error("decodeBridgeInstruction not implemented");
}
