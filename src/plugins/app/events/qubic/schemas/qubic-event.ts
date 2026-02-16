import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../../common/schemas/common.js";

const AmountSchema = Type.String({ pattern: "^[0-9]+$" });

export const QubicEventChainSchema = Type.Literal("qubic");

export const QubicEventTypeSchema = Type.Union([
  Type.Literal("lock"),
  Type.Literal("override-lock"),
]);

export const QubicLockEventPayloadSchema = Type.Object({
  fromAddress: StringSchema,
  toAddress: StringSchema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: StringSchema,
});

export const QubicOverrideLockEventPayloadSchema = Type.Object({
  toAddress: StringSchema,
  relayerFee: AmountSchema,
  nonce: StringSchema,
  fromAddress: StringSchema,
  amount: AmountSchema,
});

export const QubicEventPayloadSchema = Type.Union([
  QubicLockEventPayloadSchema,
  QubicOverrideLockEventPayloadSchema,
]);

export const QubicStoredEventSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  signature: StringSchema,
  slot: Type.Optional(Type.Integer({ minimum: 0 })),
  chain: QubicEventChainSchema,
  type: QubicEventTypeSchema,
  nonce: StringSchema,
  payload: QubicEventPayloadSchema,
  createdAt: StringSchema,
});

export type QubicEventPayload = Static<typeof QubicEventPayloadSchema>;
export type QubicStoredEvent = Static<typeof QubicStoredEventSchema>;
