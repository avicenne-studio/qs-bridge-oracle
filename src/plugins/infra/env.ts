import env from "@fastify/env";
import fp from "fastify-plugin";

declare module "fastify" {
  export interface FastifyInstance {
    config: {
      PORT: number;
      RATE_LIMIT_MAX: number;
      SQLITE_DB_FILE: string;
      SOLANA_KEYS: string;
      QUBIC_KEYS: string;
    };
  }
}

const schema = {
  type: "object",
  required: ["SQLITE_DB_FILE", "PORT", "SOLANA_KEYS", "QUBIC_KEYS"],
  properties: {
    RATE_LIMIT_MAX: {
      type: "number",
      default: 100, // Lower it to 4 in your .env.test file for tests
    },
    SQLITE_DB_FILE: {
      type: "string",
    },
    PORT: {
      type: "number",
    },
    SOLANA_KEYS: {
      type: "string",
    },
    QUBIC_KEYS: {
      type: "string",
    },
  },
};

export const autoConfig = {
  // Decorate Fastify instance with `config` key
  // Optional, default: 'config'
  confKey: "config",

  // Schema to validate
  schema,

  // Keep env loading explicit; rely on process.env or --env-file.
  dotenv: false,
  // or, pass config options available on dotenv module
  // dotenv: {
  //   path: `${import.meta.dirname}/.env`,
  //   debug: true
  // }

  // Source for the configuration data
  // Optional, default: process.env
  data: process.env,
};

/**
 * This plugins helps to check environment variables.
 *
 * @see {@link https://github.com/fastify/fastify-env}
 */
export default fp(
  async (fastify, opts) => {
    await fastify.register(env, opts);

    const { fileManager } = fastify;

    fastify.config.SOLANA_KEYS = fileManager.sanitizeKeyFilePath(
      "SOLANA_KEYS",
      fastify.config.SOLANA_KEYS
    );
    fastify.config.QUBIC_KEYS = fileManager.sanitizeKeyFilePath(
      "QUBIC_KEYS",
      fastify.config.QUBIC_KEYS
    );
  },
  { name: "env", dependencies: ['file-manager'] }
);
