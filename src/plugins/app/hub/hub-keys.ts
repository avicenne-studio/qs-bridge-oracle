import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Static, Type } from "@sinclair/typebox";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import { kFileManager, type FileManager } from "../../infra/@file-manager.js";
import { kValidation, type ValidationService } from "../common/validation.js";

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
export const kHubKeys = Symbol("app.hubKeys");

async function readHubKeysFromFile(
  filePath: string,
  fastify: FastifyInstance
): Promise<HubKeysFile> {
  const prefix = "HubKeys";
  const fileManager = fastify.getDecorator<FileManager>(kFileManager);
  const validation: ValidationService = fastify.getDecorator<ValidationService>(kValidation);
  const parsed = await fileManager.readJsonFile(prefix, filePath);
  validation.assertValid<HubKeysFile>(HubKeysFileSchema, parsed, prefix);
  return parsed;
}

export default fp(
  async function hubKeysPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const hubKeys = await readHubKeysFromFile(
      config.HUB_KEYS_FILE,
      fastify
    );
    fastify.decorate(kHubKeys, hubKeys);
  },
  {
    name: "hub-keys",
    dependencies: ["env", "validation"],
  }
);
