import { Static, Type } from "@sinclair/typebox";
import {
  QubicTransaction,
} from "./qubic-transaction.js";
import {
  SolanaTransaction,
} from "./solana-transaction.js";
import { SignatureSchema, StringSchema } from "../../common/schemas/common.js";

export const OracleChain = Type.Union([
  Type.Literal("qubic"),
  Type.Literal("solana"),
]);

export const OracleOrderStatus = Type.Union([Type.Literal("ready-for-relay")]);

export const OracleOrderSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  source: OracleChain,
  dest: OracleChain,
  from: StringSchema,
  to: StringSchema,
  amount: Type.Number(),
  relayerFee: Type.Number(),
  signature: SignatureSchema,
  status: OracleOrderStatus,
  oracle_accept_to_relay: Type.Boolean(),
  source_payload: Type.Optional(StringSchema),
});

export type OracleOrder = Static<typeof OracleOrderSchema>;

export function assertValidOracleOrder(order: OracleOrder) {
  if (order.source === order.dest) {
    throw new Error("OracleOrder: source and dest must differ");
  }
}

export function orderFromQubic(
  id: number,
  tx: QubicTransaction,
  dest: Static<typeof OracleChain>,
  signature: string
): OracleOrder {
  const order: OracleOrder = {
    id,
    source: "qubic",
    dest,
    from: tx.sender,
    to: tx.recipient,
    amount: tx.amount,
    relayerFee: 0,
    signature,
    status: "ready-for-relay",
    oracle_accept_to_relay: true,
  };
  assertValidOracleOrder(order);
  return order;
}

export function orderFromSolana(
  id: number,
  tx: SolanaTransaction,
  dest: Static<typeof OracleChain>,
  signature: string
): OracleOrder {
  const ix = tx.instructions[0];
  const decoded = normalizeBridgeInstruction(ix.data);
  const order: OracleOrder = {
    id,
    source: "solana",
    dest,
    from: decoded.from,
    to: decoded.to,
    amount: decoded.amount,
    relayerFee: 0,
    signature,
    status: "ready-for-relay",
    oracle_accept_to_relay: true,
  };
  assertValidOracleOrder(order);
  return order;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeBridgeInstruction(_data: string): {
  from: string;
  to: string;
  amount: number;
} {
  throw new Error("normalizeBridgeInstruction not implemented");
}
