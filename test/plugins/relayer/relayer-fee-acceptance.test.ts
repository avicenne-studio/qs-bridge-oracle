import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";

import envPlugin, {
  autoConfig as envAutoConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";
import relayerFeeAcceptancePlugin, {
  kRelayerFeeAcceptance,
  type RelayerFeeAcceptance,
} from "../../../src/plugins/app/relayer/relayer-fee-acceptance.js";


async function buildAcceptanceApp(ratio = "1000") {
  const app = fastify({ logger: false });
  const envOptions = {
    ...envAutoConfig,
    dotenv: false,
    data: {
      ...process.env,
      RELAYER_FEE_RATIO_MIN: ratio,
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
    const app = await buildAcceptanceApp("1000");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 1000n), true);
    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 999n), false);
    await app.close();
  });

  it("uses a distinct decimals scale for Qubic", async () => {
    const app = await buildAcceptanceApp("1000");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 500n), false);
    assert.equal(acceptance.acceptRelayToQubic(1_000_000n, 500n), true);
    await app.close();
  });

  it("rejects invalid ratio configuration", async () => {
    await assert.rejects(buildAcceptanceApp("not-a-number"));
  });

  it("throws on negative amounts", async () => {
    const app = await buildAcceptanceApp("1000");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.throws(() => acceptance.acceptRelayToSolana(-1n, 0n));
    await app.close();
  });

  it("accepts when amount is zero", async () => {
    const app = await buildAcceptanceApp("1000");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(0n, 0n), true);
    await app.close();
  });
});
