import { Static, Type } from "@sinclair/typebox";
import {
  StringSchema,
  NetworkIdSchema,
} from "../../../common/schemas/common.js";

export const SolanaHex32Schema = Type.String({ pattern: "^[0-9a-fA-F]{64}$" });
const Hex32Schema = SolanaHex32Schema;
const AmountSchema = Type.String({ pattern: "^[0-9]+$" });

export const SolanaEventTypeSchema = Type.Union([
  Type.Literal("outbound"),
  Type.Literal("override-outbound"),
  Type.Literal("inbound"),
]);

export const SolanaEventChainSchema = Type.Literal("solana");

export const SolanaOutboundEventPayloadSchema = Type.Object({
  networkIn: NetworkIdSchema,
  networkOut: NetworkIdSchema,
  tokenIn: Hex32Schema,
  tokenOut: Hex32Schema,
  fromAddress: Hex32Schema,
  toAddress: Hex32Schema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: Hex32Schema,
  orderEra: Type.Integer({ minimum: 0 }),
});

export const SolanaOverrideOutboundEventPayloadSchema = Type.Object({
  toAddress: Hex32Schema,
  relayerFee: AmountSchema,
  nonce: Hex32Schema,
});

export const SolanaInboundEventPayloadSchema = Type.Object({
  networkIn: NetworkIdSchema,
  networkOut: NetworkIdSchema,
  tokenIn: Hex32Schema,
  tokenOut: Hex32Schema,
  fromAddress: Hex32Schema,
  toAddress: Hex32Schema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: Hex32Schema,
  orderEra: Type.Integer({ minimum: 0 }),
});

export const SolanaEventPayloadSchema = Type.Union([
  SolanaOutboundEventPayloadSchema,
  SolanaOverrideOutboundEventPayloadSchema,
  SolanaInboundEventPayloadSchema,
]);

export const SolanaStoredEventSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  signature: StringSchema,
  slot: Type.Optional(Type.Integer({ minimum: 0 })),
  chain: SolanaEventChainSchema,
  type: SolanaEventTypeSchema,
  nonce: Hex32Schema,
  payload: SolanaEventPayloadSchema,
  createdAt: StringSchema,
});

const SolanaEventsCursorSchema = Type.Object({
  createdAt: StringSchema,
  id: Type.Integer({ minimum: 0 }),
});

export const SolanaEventsResponseSchema = Type.Object({
  data: Type.Array(SolanaStoredEventSchema),
  cursor: SolanaEventsCursorSchema,
});

export type SolanaEventPayload = Static<typeof SolanaEventPayloadSchema>;
export type SolanaStoredEvent = Static<typeof SolanaStoredEventSchema>;
export type SolanaEventsResponse = Static<typeof SolanaEventsResponseSchema>;
