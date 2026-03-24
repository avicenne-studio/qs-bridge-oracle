import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../../common/schemas/common.js";

const AmountSchema = Type.String({ pattern: "^[0-9]+$" });

export const QubicEventChainSchema = Type.Literal("qubic");

export const QubicEventTypeSchema = Type.Union([
  Type.Literal("lock"),
  Type.Literal("override-lock"),
  Type.Literal("unlock"),
]);

export const QubicLockEventPayloadSchema = Type.Object({
  fromAddress: StringSchema,
  toAddress: StringSchema,
  amount: AmountSchema,
  relayerFee: AmountSchema,
  nonce: StringSchema,
  orderEra: Type.String({ pattern: "^[0-9]+$" }),
});

export const QubicOverrideLockEventPayloadSchema = Type.Object({
  toAddress: StringSchema,
  relayerFee: AmountSchema,
  nonce: StringSchema,
  fromAddress: StringSchema,
  amount: AmountSchema,
  orderEra: Type.String({ pattern: "^[0-9]+$" }),
});

export const QubicUnlockEventPayloadSchema = Type.Object({
  toAddress: StringSchema,
  amount: AmountSchema,
  nonce: StringSchema,
});

export const QubicEventPayloadSchema = Type.Union([
  QubicLockEventPayloadSchema,
  QubicOverrideLockEventPayloadSchema,
  QubicUnlockEventPayloadSchema,
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
export type QubicLockEventPayload = Static<typeof QubicLockEventPayloadSchema>;
export type QubicOverrideLockEventPayload = Static<
  typeof QubicOverrideLockEventPayloadSchema
>;
export type QubicUnlockEventPayload = Static<typeof QubicUnlockEventPayloadSchema>;
export type QubicStoredEvent = Static<typeof QubicStoredEventSchema>;
