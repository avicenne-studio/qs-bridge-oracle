import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import path from "node:path";

import envPlugin, {
  autoConfig as envAutoConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";
import validationPlugin from "../../../src/plugins/app/common/validation.js";
import hubKeysPlugin, {
  kHubKeys,
  type HubKeysFile,
} from "../../../src/plugins/app/hub/hub-keys.js";

const fixturesDir = path.join(process.cwd(), "test/fixtures");
const signerFixturesDir = path.join(process.cwd(), "test/fixtures/signer");
const validSolanaKeys = path.join(signerFixturesDir, "solana.keys.json");
const validQubicKeys = path.join(signerFixturesDir, "qubic.keys.json");

const validHubKeys = path.join(fixturesDir, "hub-keys.json");
const invalidHubKeys = path.join(fixturesDir, "hub-keys.invalid.json");
const malformedHubKeys = path.join(fixturesDir, "hub-keys.malformed.json");
const missingHubKeys = path.join(fixturesDir, "hub-keys.missing.json");
const unreadableHubKeys = path.join(fixturesDir, "hub-keys-dir.json");

type HubKeysEnvOverrides = Partial<{
  HUB_KEYS_FILE: string;
}>;

async function buildHubKeysApp(overrides: HubKeysEnvOverrides = {}) {
  const app = fastify();
  const envOptions = {
    ...envAutoConfig,
    dotenv: false,
    data: {
      ...process.env,
      SOLANA_KEYS: validSolanaKeys,
      QUBIC_KEYS: validQubicKeys,
      HUB_URLS: "http://127.0.0.1:3010,http://127.0.0.1:3011",
      HUB_KEYS_FILE: overrides.HUB_KEYS_FILE ?? validHubKeys,
      SOLANA_WS_URL: "ws://localhost:8900",
      SOLANA_LISTENER_ENABLED: false,
      SOLANA_BPS_FEE: 25,
    },
  };

  try {
    await app.register(fmPlugin);
    await app.register(validationPlugin);
    await app.register(envPlugin, envOptions);
    await app.register(hubKeysPlugin);
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

describe("hub-keys", () => {
  it("rejects when HUB_KEYS_FILE is not a JSON file", async () => {
    await assert.rejects(
      buildHubKeysApp({ HUB_KEYS_FILE: "./hub-keys.txt" }),
      /HUB_KEYS_FILE must point to a JSON file/
    );
  });

  it("rejects when HUB_KEYS_FILE contains traversal sequences", async () => {
    await assert.rejects(
      buildHubKeysApp({
        HUB_KEYS_FILE: "../test/fixtures/hub-keys.json",
      }),
      /HUB_KEYS_FILE must not contain parent directory traversal/
    );
  });

  it("rejects when hub keys file cannot be parsed as JSON", async () => {
    await assert.rejects(
      buildHubKeysApp({ HUB_KEYS_FILE: malformedHubKeys }),
      /HubKeys: file does not contain valid JSON/
    );
  });

  it("rejects when hub keys file does not match the schema", async () => {
    await assert.rejects(
      buildHubKeysApp({ HUB_KEYS_FILE: invalidHubKeys }),
      /HubKeys: invalid schema/
    );
  });

  it("rejects when hub keys file is missing", async () => {
    await assert.rejects(
      buildHubKeysApp({ HUB_KEYS_FILE: missingHubKeys }),
      /HubKeys: file not found/
    );
  });

  it("rejects when hub keys file cannot be read", async () => {
    await assert.rejects(
      buildHubKeysApp({ HUB_KEYS_FILE: unreadableHubKeys }),
      /HubKeys: unable to read file/
    );
  });

  it("decorates hubKeys when inputs are valid", async (t) => {
    const app = await buildHubKeysApp();
    t.after(() => app.close());
    const hubKeys: HubKeysFile = app.getDecorator(kHubKeys);

    assert.strictEqual(hubKeys.primary.current.kid, "primary-current");
    assert.strictEqual(hubKeys.fallback.next.kid, "fallback-next");
  });
});
