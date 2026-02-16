import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../common/schemas/common.js";
import {
  SolanaEventChainSchema,
  SolanaEventPayloadSchema,
  SolanaEventTypeSchema,
  SolanaHex32Schema,
} from "../solana/schemas/solana-event.js";
import {
  QubicEventChainSchema,
  QubicEventPayloadSchema,
  QubicEventTypeSchema,
} from "../qubic/schemas/qubic-event.js";

export const HubEventChainSchema = Type.Union([
  SolanaEventChainSchema,
  QubicEventChainSchema,
]);

export const HubEventTypeSchema = Type.Union([
  SolanaEventTypeSchema,
  QubicEventTypeSchema,
]);

export const HubEventNonceSchema = Type.Union([
  SolanaHex32Schema,
  StringSchema,
]);

export const HubEventPayloadSchema = Type.Union([
  SolanaEventPayloadSchema,
  QubicEventPayloadSchema,
]);

export const HubStoredEventSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  signature: StringSchema,
  slot: Type.Optional(Type.Integer({ minimum: 0 })),
  chain: HubEventChainSchema,
  type: HubEventTypeSchema,
  nonce: HubEventNonceSchema,
  payload: HubEventPayloadSchema,
  createdAt: StringSchema,
});

const HubEventsCursorSchema = Type.Object({
  createdAt: StringSchema,
  id: Type.Integer({ minimum: 0 }),
});

export const HubEventsResponseSchema = Type.Object({
  data: Type.Array(HubStoredEventSchema),
  cursor: HubEventsCursorSchema,
});

export type HubEventChain = Static<typeof HubEventChainSchema>;
export type HubEventType = Static<typeof HubEventTypeSchema>;
export type HubEventPayload = Static<typeof HubEventPayloadSchema>;
export type HubStoredEvent = Static<typeof HubStoredEventSchema>;
export type HubEventsResponse = Static<typeof HubEventsResponseSchema>;
