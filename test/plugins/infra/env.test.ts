import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import path from "node:path";

import envPlugin, {
  autoConfig as envAutoConfig,
  EnvConfig,
  kEnvConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";

const fixturesDir = path.join(process.cwd(), "test/fixtures");
const signerFixturesDir = path.join(process.cwd(), "test/fixtures/signer");
const validSolanaKeys = path.join(signerFixturesDir, "solana.keys.json");
const validQubicKeys = path.join(signerFixturesDir, "qubic.keys.json");
const validHubKeys = path.join(fixturesDir, "hub-keys.json");

type EnvOverrides = Partial<{
  HOST: string;
  PORT: number;
}>;

async function buildEnvApp(overrides: EnvOverrides = {}) {
  const app = fastify();
  const envOptions = {
    ...envAutoConfig,
    dotenv: false,
    data: {
      ...process.env,
      SQLITE_DB_FILE: "./data/oracle.sqlite3",
      HOST: overrides.HOST ?? "0.0.0.0",
      PORT: overrides.PORT ?? 3000,
      SOLANA_KEYS: validSolanaKeys,
      QUBIC_KEYS: validQubicKeys,
      HUB_URLS: "http://127.0.0.1:3010,http://127.0.0.1:3011",
      HUB_KEYS_FILE: validHubKeys,
      SOLANA_RPC_URL: "http://localhost:8899",
      SOLANA_BPS_FEE: 25,
      RELAYER_FEE_PERCENT: "0.1",
    },
  };

  try {
    await app.register(fmPlugin);
    await app.register(envPlugin, envOptions);
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

describe("env", () => {
  it("loads when HOST is valid", async () => {
    const hosts = [
      "localhost",
      "0.0.0.0",
      "127.0.0.1",
      "example.com",
      "sub.domain.example",
      "[::1]",
      "[2001:db8::1]",
    ];

    for (const host of hosts) {
      const app = await buildEnvApp({ HOST: host });
      const config = app.getDecorator<EnvConfig>(kEnvConfig);
      assert.strictEqual(config.HOST, host);
      assert.strictEqual(config.PORT, 3000);
      await app.close();
    }
  });

  it("rejects when HOST is invalid", async () => {
    const hosts = [
      "http://localhost",
      "bad_host",
      "example..com",
      "-bad.example",
      "bad-.example",
      ".example",
      "example.com.",
      "",
    ];

    for (const host of hosts) {
      await assert.rejects(buildEnvApp({ HOST: host }));
    }
  });
});
