import { Static, Type } from "@sinclair/typebox";

const Hex32Schema = Type.String({ pattern: "^[0-9a-fA-F]{64}$" });

export const SolanaOrderSourcePayloadSchema = Type.Object({
  v: Type.Literal(1),
  networkIn: Type.Integer({ minimum: 0 }),
  networkOut: Type.Integer({ minimum: 0 }),
  tokenIn: Hex32Schema,
  tokenOut: Hex32Schema,
  nonce: Hex32Schema,
  orderEra: Type.Integer({ minimum: 0 }),
});

export type SolanaOrderSourcePayloadV1 = Static<
  typeof SolanaOrderSourcePayloadSchema
>;
