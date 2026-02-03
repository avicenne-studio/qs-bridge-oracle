import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getInboundEventEncoder } from "../../../../src/clients/js/types/inboundEvent.js";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";
import {
  createSolanaEventValidator,
  SolanaEventValidator,
} from "../../../../src/plugins/app/events/solana/solana-events-validator.js";
import solanaEventsValidatorPlugin, {
  kSolanaEventValidator,
} from "../../../../src/plugins/app/events/solana/solana-events-validator.js";
import fastify from "fastify";
import fp from "fastify-plugin";
import { kEnvConfig } from "../../../../src/plugins/infra/env.js";
import { Connection } from "@solana/web3.js";

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      discriminator: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: new Uint8Array(32).fill(1),
      tokenOut: new Uint8Array(32).fill(2),
      fromAddress: new Uint8Array(32).fill(3),
      toAddress: new Uint8Array(32).fill(4),
      amount: 10n,
      relayerFee: 2n,
      nonce: new Uint8Array(32).fill(5),
    })
  );
}

function createInboundEventBytes() {
  const encoder = getInboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      discriminator: 0,
      networkIn: 1,
      networkOut: 2,
      tokenIn: new Uint8Array(32).fill(9),
      tokenOut: new Uint8Array(32).fill(8),
      fromAddress: new Uint8Array(32).fill(7),
      toAddress: new Uint8Array(32).fill(6),
      amount: 12n,
      relayerFee: 1n,
      nonce: new Uint8Array(32).fill(5),
    })
  );
}

function createEvent() {
  const hex = (value: number) =>
    Buffer.from(new Uint8Array(32).fill(value)).toString("hex");
  return {
    id: 1,
    signature: "sig-ok",
    slot: 12,
    chain: "solana",
    type: "outbound",
    nonce: hex(5),
    payload: {
      networkIn: 1,
      networkOut: 1,
      tokenIn: hex(1),
      tokenOut: hex(2),
      fromAddress: hex(3),
      toAddress: hex(4),
      amount: "10",
      relayerFee: "2",
      nonce: hex(5),
    },
    createdAt: new Date().toISOString(),
  } as const;
}

describe("solana event validator", () => {
  it("validates matching events", async () => {
    const bytes = createOutboundEventBytes();
    const logs = [`Program data: ${Buffer.from(bytes).toString("base64")}`];
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: logs },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await validator.validate(createEvent());
  });

  it("defaults to confirmed commitment when not provided", async () => {
    const bytes = createOutboundEventBytes();
    const logs = [`Program data: ${Buffer.from(bytes).toString("base64")}`];
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: logs },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
    });

    await validator.validate(createEvent());
  });

  it("ignores inbound events while validating outbound events", async () => {
    const outboundBytes = createOutboundEventBytes();
    const inboundBytes = createInboundEventBytes();
    const logs = [
      `Program data: ${Buffer.from(inboundBytes).toString("base64")}`,
      `Program data: ${Buffer.from(outboundBytes).toString("base64")}`,
    ];
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: logs },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await validator.validate(createEvent());
  });

  it("throws when transaction is missing", async () => {
    const validator = createSolanaEventValidator({
      getTransaction: async () => null,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /Transaction not found/
    );
  });

  it("throws when transaction fails", async (t) => {
    const logger = { warn: () => {} };
    const { mock: warnMock } = t.mock.method(logger, "warn");
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: "boom", logMessages: [] },
        }) as never,
      logger,
      sleep: async () => {},
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /Transaction failed/
    );
    assert.strictEqual(warnMock.calls[0].arguments[1], "Solana transaction failed");
  });

  it("throws when events do not match", async () => {
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: [] },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /do not match/
    );
  });

  it("validates matching override events", async () => {
    const encoder = getOverrideOutboundEventEncoder();
    const nonce = new Uint8Array(32).fill(9);
    const bytes = new Uint8Array(
      encoder.encode({
        discriminator: 2,
        toAddress: new Uint8Array(32).fill(7),
        relayerFee: 3n,
        nonce,
      })
    );
    const logs = [`Program data: ${Buffer.from(bytes).toString("base64")}`];
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: logs },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await validator.validate({
      id: 2,
      signature: "sig-override",
      slot: 13,
      chain: "solana",
      type: "override-outbound",
      nonce: Buffer.from(nonce).toString("hex"),
      payload: {
        toAddress: Buffer.from(new Uint8Array(32).fill(7)).toString("hex"),
        relayerFee: "3",
        nonce: Buffer.from(nonce).toString("hex"),
      },
      createdAt: new Date().toISOString(),
    });
  });

  it("registers the validator plugin", async (t: TestContext) => {
    const app = fastify({ logger: false });
    app.register(
      fp(async (instance) => {
        instance.decorate(kEnvConfig, { SOLANA_RPC_URL: "http://localhost:8899" });
      }, { name: "env" })
    );
    t.mock.method(Connection.prototype, "getTransaction", async () => null);
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [null],
    }));
    app.register(solanaEventsValidatorPlugin);
    await app.ready();

    const validator = app.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
    t.assert.ok(validator);
    await assert.rejects(() => validator.validate(createEvent()), /Transaction not found/);
    await app.close();
  });

  it("uses confirmed finality for processed commitment", async (t: TestContext) => {
    const app = fastify({ logger: false });
    app.register(
      fp(async (instance) => {
        instance.decorate(kEnvConfig, {
          SOLANA_RPC_URL: "http://localhost:8899",
          SOLANA_TX_COMMITMENT: "processed",
        });
      }, { name: "env" })
    );

    let seenCommitment: unknown = null;
    t.mock.method(
      Connection.prototype,
      "getTransaction",
      async (_signature: string, options?: { commitment?: string }) => {
        seenCommitment = options?.commitment ?? null;
        return null;
      }
    );
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [null],
    }));
    app.register(solanaEventsValidatorPlugin);
    await app.ready();

    const validator = app.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
    await assert.rejects(() => validator.validate(createEvent()), /Transaction not found/);
    assert.strictEqual(seenCommitment, "confirmed");
    await app.close();
  });

  it("handles unknown event sizes", async () => {
    const logs = [`Program data: ${Buffer.from(new Uint8Array(12)).toString("base64")}`];
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: logs },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /do not match/
    );
  });

  it("rejects mismatched payload shapes", async () => {
    const bytes = createOutboundEventBytes();
    const logs = [`Program data: ${Buffer.from(bytes).toString("base64")}`];
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null, logMessages: logs },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await assert.rejects(
      () =>
        validator.validate({
          ...createEvent(),
          type: "outbound",
          payload: {
            toAddress: Buffer.from(new Uint8Array(32).fill(7)).toString("hex"),
            relayerFee: "3",
            nonce: Buffer.from(new Uint8Array(32).fill(9)).toString("hex"),
          },
        }),
      /do not match/
    );
  });

  it("handles missing log messages", async () => {
    const validator = createSolanaEventValidator({
      getTransaction: async () =>
        ({
          meta: { err: null },
        }) as never,
      logger: {
        warn: () => {},
      },
      sleep: async () => {},
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /do not match/
    );
  });

  it("retries when signature status indicates higher commitment", async () => {
    let calls = 0;
    let sleeps = 0;
    const validator = createSolanaEventValidator({
      getTransaction: async () => {
        calls += 1;
        return null;
      },
      getSignatureStatus: async () => ({
        confirmationStatus: "finalized",
      }),
      logger: {
        warn: () => {},
      },
      sleep: async () => {
        sleeps += 1;
      },
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /Transaction not found/
    );
    assert.strictEqual(calls, 2);
    assert.strictEqual(sleeps, 1);
  });

  it("throws when signature status reports an error", async (t) => {
    const logger = { warn: () => {} };
    const { mock: warnMock } = t.mock.method(logger, "warn");
    const validator = createSolanaEventValidator({
      getTransaction: async () => null,
      getSignatureStatus: async () => ({
        confirmationStatus: "confirmed",
        err: "boom",
      }),
      logger,
      sleep: async () => {},
      retry: { maxAttempts: 1 },
      commitment: "confirmed",
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /Transaction failed/
    );
    assert.strictEqual(warnMock.calls.length > 0, true);
  });
});
