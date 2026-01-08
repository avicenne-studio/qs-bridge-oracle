import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Static, Type } from "@sinclair/typebox";

const HubKeySchema = Type.Object({
  kid: Type.String({ minLength: 1 }),
  publicKeyPem: Type.String({ minLength: 1 }),
});

const HubKeySetSchema = Type.Object({
  current: HubKeySchema,
  next: HubKeySchema,
});

export const HubKeysFileSchema = Type.Object({
  primary: HubKeySetSchema,
  fallback: HubKeySetSchema,
});

export type HubKeysFile = Static<typeof HubKeysFileSchema>;

declare module "fastify" {
  interface FastifyInstance {
    hubKeys: HubKeysFile;
  }
}

async function readHubKeysFromFile(
  filePath: string,
  fastify: FastifyInstance
): Promise<HubKeysFile> {
  const prefix = "HubKeys";
  const parsed = await fastify.fileManager.readJsonFile(prefix, filePath);
  fastify.validation.assertValid<HubKeysFile>(HubKeysFileSchema, parsed, prefix);
  return parsed;
}

export default fp(
  async function hubKeysPlugin(fastify: FastifyInstance) {
    const hubKeys = await readHubKeysFromFile(
      fastify.config.HUB_KEYS_FILE,
      fastify
    );
    fastify.decorate("hubKeys", hubKeys);
  },
  {
    name: "hub-keys",
    dependencies: ["env", "validation"],
  }
);
