import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import path from "node:path";

import envPlugin, {
  autoConfig as envAutoConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";
import signerService from "../../../src/plugins/app/signer/signer.service.js";

const fixturesDir = path.join(process.cwd(), "test/fixtures/signer");
const validSolanaKeys = path.join(fixturesDir, "solana.keys.json");
const validQubicKeys = path.join(fixturesDir, "qubic.keys.json");
const invalidStructureFile = path.join(fixturesDir, "invalid.keys.json");
const malformedFile = path.join(fixturesDir, "malformed.keys.json");
const missingFile = path.join(fixturesDir, "missing.keys.json");
const unreadablePath = path.join(fixturesDir, "directory.json");

type SignerEnvOverrides = Partial<{
  SOLANA_KEYS: string;
  QUBIC_KEYS: string;
}>;

async function buildSignerApp(overrides: SignerEnvOverrides = {}) {
  const app = fastify();
  const envOptions = {
    ...envAutoConfig,
    dotenv: false,
    data: {
      ...process.env,
      SOLANA_KEYS: overrides.SOLANA_KEYS ?? validSolanaKeys,
      QUBIC_KEYS: overrides.QUBIC_KEYS ?? validQubicKeys,
    },
  };

  try {
    await app.register(fmPlugin)
    await app.register(envPlugin, envOptions);
    await app.register(signerService);
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

describe("signerService", () => {
  it("rejects when SOLANA_KEYS is not a JSON file", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: "./keys.txt" }),
      /SOLANA_KEYS must point to a JSON file/
    );
  });

  it("rejects when QUBIC_KEYS contains traversal sequences", async () => {
    await assert.rejects(
      buildSignerApp({ QUBIC_KEYS: "../test/fixtures/signer/qubic.keys.json" }),
      /QUBIC_KEYS must not contain parent directory traversal/
    );
  });

  it("rejects when a keys file cannot be parsed as JSON", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: malformedFile }),
      /SignerService\(SOLANA_KEYS\): file does not contain valid JSON/
    );
  });

  it("rejects when a keys file does not match the schema", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: invalidStructureFile }),
      /SignerService\(SOLANA_KEYS\): invalid schema/
    );
  });

  it("rejects when a keys file is missing", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: missingFile }),
      /SignerService\(SOLANA_KEYS\): file not found/
    );
  });

  it("rejects when a keys file cannot be read", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: unreadablePath }),
      /SignerService\(SOLANA_KEYS\): unable to read file/
    );
  });

  it("decorates signerService with both key sets when inputs are valid", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());

    assert.deepStrictEqual(app.signerService.solana, {
      pKey: "SOLANA_PUBLIC_KEY",
      sKey: "SOLANA_SECRET_KEY",
    });
    assert.deepStrictEqual(app.signerService.qubic, {
      pKey: "QUBIC_PUBLIC_KEY",
      sKey: "QUBIC_SECRET_KEY",
    });
  });
});
