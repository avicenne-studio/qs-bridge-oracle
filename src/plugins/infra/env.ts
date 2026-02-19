import env from "@fastify/env";
import fp from "fastify-plugin";
import { kFileManager, type FileManager } from "./@file-manager.js";

export type EnvConfig = {
  HOST: string;
  PORT: number;
  RATE_LIMIT_MAX: number;
  POLLER_INTERVAL_MS: number;
  POLLER_REQUEST_TIMEOUT_MS: number;
  POLLER_JITTER_MS: number;
  SQLITE_DB_FILE: string;
  SOLANA_KEYS: string;
  QUBIC_KEYS: string;
  ORACLE_SIGNATURE_THRESHOLD: number;
  ORACLE_ID?: string;
  HUB_URLS: string;
  HUB_KEYS_FILE: string;
  SOLANA_RPC_URL: string;
  SOLANA_WS_URL: string;
  QUBIC_RPC_URL: string;
  SOLANA_TX_COMMITMENT: "processed" | "confirmed" | "finalized";
  SOLANA_TX_RETRY_MAX_ATTEMPTS?: number;
  SOLANA_TX_RETRY_BASE_MS?: number;
  SOLANA_TX_RETRY_MAX_MS?: number;
  SOLANA_MAX_PRIORITY_FEE: number;
  SOLANA_LOOKUP_TABLE_ADDRESS: string;
  TOKEN_MINT: string;
  RELAYER_FEE_SOLANA: string;
  RELAYER_FEE_QUBIC: string;
  RELAYER_ENABLED: boolean;
  RELAYER_PROCESS_INTERVAL_MS: number;
  RELAYER_MAX_ATTEMPTS: number;
  EVENT_MAX_RETRIES: number;
  EVENTS_LOOKBACK_DAYS: number;
  EVENTS_PROCESS_INTERVAL_MS: number;
};

export const kEnvConfig = "config";

const schema = {
  type: "object",
  required: [
    "SQLITE_DB_FILE",
    "HOST",
    "PORT",
    "SOLANA_KEYS",
    "QUBIC_KEYS",
    "HUB_URLS",
    "HUB_KEYS_FILE",
    "SOLANA_RPC_URL",
    "SOLANA_WS_URL",
    "QUBIC_RPC_URL",
    "TOKEN_MINT",
    "SOLANA_TX_COMMITMENT",
    "RELAYER_FEE_SOLANA",
    "RELAYER_FEE_QUBIC",
    "SOLANA_LOOKUP_TABLE_ADDRESS",
  ],
  properties: {
    RATE_LIMIT_MAX: {
      type: "number",
      default: 100, // Lower it to 4 in your .env.test file for tests
    },
    POLLER_INTERVAL_MS: {
      type: "number",
      minimum: 1000,
      default: 10_000,
    },
    POLLER_REQUEST_TIMEOUT_MS: {
      type: "number",
      minimum: 0,
      default: 700,
    },
    POLLER_JITTER_MS: {
      type: "number",
      minimum: 0,
      default: 25,
    },
    SQLITE_DB_FILE: {
      type: "string",
    },
    HOST: {
      type: "string",
      pattern:
        "^(?:localhost|(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)|(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*|\\[[0-9A-Fa-f:.]+\\])$",
    },
    PORT: {
      type: "number",
    },
    ORACLE_SIGNATURE_THRESHOLD: {
      type: "number",
      minimum: 1,
      default: 2,
    },
    SOLANA_KEYS: {
      type: "string",
    },
    QUBIC_KEYS: {
      type: "string",
    },
    ORACLE_ID: {
      type: "string",
    },
    HUB_URLS: {
      type: "string",
      pattern:
        "^https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?(,https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?)*$",
    },
    HUB_KEYS_FILE: {
      type: "string",
    },
    SOLANA_RPC_URL: {
      type: "string",
    },
    SOLANA_WS_URL: {
      type: "string",
    },
    QUBIC_RPC_URL: {
      type: "string",
    },
    SOLANA_TX_COMMITMENT: {
      type: "string",
      enum: ["processed", "confirmed", "finalized"],
      default: "confirmed",
    },
    SOLANA_TX_RETRY_MAX_ATTEMPTS: {
      type: "number",
      minimum: 1,
      default: 6,
    },
    SOLANA_TX_RETRY_BASE_MS: {
      type: "number",
      minimum: 1,
      default: 500,
    },
    SOLANA_TX_RETRY_MAX_MS: {
      type: "number",
      minimum: 1,
      default: 4000,
    },
    SOLANA_MAX_PRIORITY_FEE: {
      type: "number",
      minimum: 0,
      default: 100_000,
    },
    SOLANA_LOOKUP_TABLE_ADDRESS: {
      type: "string",
    },
    TOKEN_MINT: {
      type: "string",
    },
    RELAYER_FEE_SOLANA: {
      type: "string",
      pattern: "^[0-9]+$",
    },
    RELAYER_FEE_QUBIC: {
      type: "string",
      pattern: "^[0-9]+$",
    },
    RELAYER_ENABLED: {
      type: "boolean",
      default: true,
    },
    RELAYER_PROCESS_INTERVAL_MS: {
      type: "number",
      minimum: 500,
      default: 3000,
    },
    RELAYER_MAX_ATTEMPTS: {
      type: "number",
      minimum: 1,
      default: 3,
    },
    EVENT_MAX_RETRIES: {
      type: "number",
      minimum: 1,
      default: 3,
    },
    EVENTS_LOOKBACK_DAYS: {
      type: "number",
      minimum: 1,
      default: 14,
    },
    EVENTS_PROCESS_INTERVAL_MS: {
      type: "number",
      minimum: 500,
      default: 2000,
    },
  },
};

export const autoConfig = {
  // Decorate Fastify instance with `config` key
  // Optional, default: 'config'
  confKey: kEnvConfig,

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
    if (!fastify.hasDecorator(kEnvConfig)) {
      await fastify.register(env, opts);
    }

    const fileManager = fastify.getDecorator<FileManager>(kFileManager);
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);

    config.SOLANA_KEYS = fileManager.sanitizeKeyFilePath(
      "SOLANA_KEYS",
      config.SOLANA_KEYS
    );
    config.QUBIC_KEYS = fileManager.sanitizeKeyFilePath(
      "QUBIC_KEYS",
      config.QUBIC_KEYS
    );
    config.HUB_KEYS_FILE = fileManager.sanitizeKeyFilePath(
      "HUB_KEYS_FILE",
      config.HUB_KEYS_FILE
    );
  },
  { name: "env", dependencies: ['file-manager'] }
);
