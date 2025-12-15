import { Static, Type } from "@sinclair/typebox";
import { StringSchema } from "../../common/schemas/common.js";

export const SignerKeysSchema = Type.Object({
  pKey: StringSchema,
  sKey: StringSchema,
});

export type SignerKeys = Static<typeof SignerKeysSchema>;
