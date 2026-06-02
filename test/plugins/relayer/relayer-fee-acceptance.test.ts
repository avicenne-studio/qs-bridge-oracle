import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { type EnvConfig } from "../../../src/plugins/infra/env.js";
import {
  kRelayerFeeAcceptance,
  type RelayerFeeAcceptance,
} from "../../../src/plugins/app/relayer/relayer-fee-acceptance.js";
import { DEFAULT_TEST_CONFIG, build } from "../../helpers/build.js";

async function buildAcceptanceApp(
  t: Parameters<typeof build>[0],
  solanaFee = "1000",
  qubicFee = "500"
) {
  return build(t, {
    config: {
      RELAYER_FEE_TO_SOLANA: solanaFee,
      RELAYER_FEE_TO_QUBIC: qubicFee,
    },
  });
}

function buildBaseConfig(): EnvConfig {
  return {
    ...DEFAULT_TEST_CONFIG,
  };
}

describe("relayerFeeAcceptance", () => {
  it("accepts when relayer fee meets the Solana minimum", async (t) => {
    const app = await buildAcceptanceApp(t, "1000", "500");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 1000n), true);
    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 999n), false);
  });

  it("accepts for both chains with the same fee input", async (t) => {
    const app = await buildAcceptanceApp(t, "1000", "1000");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(1_000_000n, 1000n), true);
    assert.equal(acceptance.acceptRelayToQubic(1_000_000n, 1000n), true);
  });

  it("rejects invalid fee configuration", async () => {
    await assert.rejects(buildAcceptanceApp(undefined, "not-a-number", "1000"));
    await assert.rejects(buildAcceptanceApp(undefined, "1000", "nope"));
  });

  it("rejects non-integer relayer fee values", async () => {
    const baseConfig = buildBaseConfig();
    await assert.rejects(
      build(undefined, {
        config: {
          ...baseConfig,
          RELAYER_FEE_TO_SOLANA: "10.5",
        },
      }),
      /RELAYER_FEE_TO_SOLANA/
    );
    await assert.rejects(
      build(undefined, {
        config: {
          ...baseConfig,
          RELAYER_FEE_TO_QUBIC: "10.5",
        },
      }),
      /RELAYER_FEE_TO_QUBIC/
    );
  });

  it("throws on negative amounts", async (t) => {
    const app = await buildAcceptanceApp(t, "1000", "500");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.throws(() => acceptance.acceptRelayToSolana(-1n, 0n));
    assert.throws(() => acceptance.acceptRelayToQubic(-1n, 0n));
  });

  it("accepts when amount is zero", async (t) => {
    const app = await buildAcceptanceApp(t, "1000", "500");
    const acceptance = app.getDecorator<RelayerFeeAcceptance>(
      kRelayerFeeAcceptance
    );

    assert.equal(acceptance.acceptRelayToSolana(0n, 0n), false);
  });
});
