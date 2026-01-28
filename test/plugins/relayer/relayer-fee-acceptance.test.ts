import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import path from "node:path";

import envPlugin, {
  autoConfig as envAutoConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";
import relayerFeeAcceptancePlugin, {
  kRelayerFeeAcceptance,
  type RelayerFeeAcceptance,
} from "../../../src/plugins/app/relayer/relayer-fee-acceptance.js";

const fixturesDir = path.join(process.cwd(), "test/fixtures");
const signerFixturesDir = path.join(process.cwd(), "test/fixtures/signer");
const validSolanaKeys = path.join(signerFixturesDir, "solana.keys.json");
const validQubicKeys = path.join(signerFixturesDir, "qubic.keys.json");
const validHubKeys = path.join(fixturesDir, "hub-keys.json");

async function buildAcceptanceApp(percent = "0.1") {
  const app = fastify({ logger: false });
  const envOptions = {
    ...envAutoConfig,
    dotenv: false,
    data: {
      ...process.env,
      SQLITE_DB_FILE: "./data/oracle.sqlite3",
      HOST: "0.0.0.0",
      PORT: 3000,
      SOLANA_KEYS: validSolanaKeys,
      QUBIC_KEYS: validQubicKeys,
      HUB_URLS: "http://127.0.0.1:3010,http://127.0.0.1:3011",
      HUB_KEYS_FILE: validHubKeys,
      SOLANA_RPC_URL: "http://localhost:8899",
      SOLANA_BPS_FEE: 25,
      RELAYER_FEE_PERCENT: percent,
    },
  };

  try {
    await app.register(fmPlugin);
    await app.register(envPlugin, envOptions);
    await app.register(relayerFeeAcceptancePlugin);
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

describe("relayerFeeAcceptance", () => {
  it("accepts when relayer fee meets the Solana minimum", async () => {
    const app = await buildAcceptanceApp("0.1");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 1000n), true);
    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 999n), false);
    await app.close();
  });

  it("accepts for both chains with the same percent input", async () => {
    const app = await buildAcceptanceApp("0.1");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 1000n), true);
    assert.equal(acceptance.acceptRelayToQubic(1_000_000n, 1000n), true);
    await app.close();
  });

  it("rejects invalid percent configuration", async () => {
    await assert.rejects(buildAcceptanceApp("not-a-number"));
  });

  it("throws on negative amounts", async () => {
    const app = await buildAcceptanceApp("0.1");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.throws(() => acceptance.acceptRelayToSolana(-1n, 0n));
    await app.close();
  });

  it("accepts when amount is zero", async () => {
    const app = await buildAcceptanceApp("0.1");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(0n, 0n), true);
    await app.close();
  });
});
