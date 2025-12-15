import fs from "node:fs/promises";
import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Value } from "@sinclair/typebox/value";
import {
  SignerKeys,
  SignerKeysSchema,
} from "./schemas/keys.js";

type SignerService = {
  solana: SignerKeys;
  qubic: SignerKeys;
};

declare module "fastify" {
  interface FastifyInstance {
    signerService: SignerService;
  }
}

async function readKeysFromFile(
  variableName: "SOLANA_KEYS" | "QUBIC_KEYS",
  filePath: string
): Promise<SignerKeys> {
  const prefix = `SignerService(${variableName})`;

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`${prefix}: file not found at ${filePath}`);
    }
    throw new Error(`${prefix}: unable to read file - ${err.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${prefix}: file does not contain valid JSON`);
  }

  if (!Value.Check(SignerKeysSchema, parsed)) {
    let errorMessage = "Invalid keys structure";
    for (const error of Value.Errors(SignerKeysSchema, parsed)) {
      errorMessage = `${error.message} at ${error.path}`;
      break;
    }
    throw new Error(`${prefix}: invalid schema - ${errorMessage}`);
  }

  return parsed;
}

export default fp(
  async function signerService(fastify: FastifyInstance) {
    const solana = await readKeysFromFile(
      "SOLANA_KEYS",
      fastify.config.SOLANA_KEYS
    );
    const qubic = await readKeysFromFile(
      "QUBIC_KEYS",
      fastify.config.QUBIC_KEYS
    );

    fastify.decorate("signerService", { solana, qubic });
  },
  {
    name: "signer-service",
    dependencies: ["env"],
  }
);
