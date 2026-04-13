import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../helpers/build.js";
import { kRelayerService } from "../../../src/plugins/app/relayer/relayer.js";

describe("relayerPlugin", () => {
  it("registers and starts when RELAYER_ENABLED is true", async (t) => {
    const app = await build(t, {
      useMocks: false,
      config: {
        RELAYER_ENABLED: true,
        RELAYER_PROCESS_INTERVAL_MS: 60_000,
        QUBIC_BROADCAST_RPC_URL: "http://127.0.0.1:1",
      },
    });
    const relayer = app.getDecorator(kRelayerService);
    assert.ok(relayer, "expected kRelayerService to be decorated on the app");
  });

  it("skips registration when RELAYER_ENABLED is false", async (t) => {
    const app = await build(t, {
      useMocks: false,
      config: {
        RELAYER_ENABLED: false,
      },
    });
    assert.ok(!app.hasDecorator(kRelayerService), "expected kRelayerService to NOT be decorated");
  });
});
