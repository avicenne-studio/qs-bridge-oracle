import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
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
  filePath: string,
  fastify: FastifyInstance
): Promise<SignerKeys> {
  const prefix = `SignerService(${variableName})`;
  const parsed = await fastify.fileManager.readJsonFile(prefix, filePath);
  fastify.validation.assertValid<SignerKeys>(SignerKeysSchema, parsed, prefix);
  return parsed;
}

export default fp(
  async function signerService(fastify: FastifyInstance) {
    const solana = await readKeysFromFile(
      "SOLANA_KEYS",
      fastify.config.SOLANA_KEYS,
      fastify
    );
    const qubic = await readKeysFromFile(
      "QUBIC_KEYS",
      fastify.config.QUBIC_KEYS,
      fastify
    );

    fastify.decorate("signerService", { solana, qubic });
  },
  {
    name: "signer-service",
    dependencies: ["env", "validation"],
  }
);
