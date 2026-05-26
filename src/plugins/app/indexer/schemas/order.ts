import { Static, Type } from "@sinclair/typebox";
import {
  IdSchema,
  SignatureSchema,
  StringSchema,
} from "../../common/schemas/common.js";

export const OracleChain = Type.Union([
  Type.Literal("qubic"),
  Type.Literal("solana"),
]);

export const OracleOrderStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready-for-relay"),
  Type.Literal("transaction-broadcasted"),
  Type.Literal("relayed"),
  Type.Literal("failed"),
  Type.Literal("finalized"),
]);
const AmountSchema = Type.String({ pattern: "^[0-9]+$" });

export const OracleOrderSchema = Type.Object({
  id: IdSchema,
  source: OracleChain,
  dest: OracleChain,
  from: StringSchema,
  to: StringSchema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  origin_trx_hash: Type.String({ minLength: 1, maxLength: 255 }),
  destination_trx_hash: Type.Optional(
    Type.String({ maxLength: 255 })
  ),
  destination_order_hash: Type.Optional(
    Type.String({ maxLength: 64 })
  ),
  destination_target_tick: Type.Optional(Type.Integer({ minimum: 0 })),
  created_at: Type.Optional(Type.String({ minLength: 1 })),
  next_relay_at: Type.Optional(Type.String({ minLength: 1 })),
  last_relay_error: Type.Optional(Type.String({ maxLength: 512 })),
  signature: SignatureSchema,
  status: OracleOrderStatus,
  oracle_accept_to_relay: Type.Boolean(),
  relay_attempts: Type.Integer({ minimum: 0 }),
  source_nonce: StringSchema,
  source_payload: StringSchema,
  order_era: Type.Integer({ minimum: 0 }),
  failure_reason_public: Type.Optional(Type.String({ maxLength: 255 })),
});

export type OracleOrder = Static<typeof OracleOrderSchema>;

export function assertValidOracleOrder(order: OracleOrder) {
  if (order.source === order.dest) {
    throw new Error("OracleOrder: source and dest must differ");
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeBridgeInstruction(_data: string): {
  from: string;
  to: string;
  amount: string;
} {
  throw new Error("normalizeBridgeInstruction not implemented");
}
