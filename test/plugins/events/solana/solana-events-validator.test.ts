import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";
import {
  createSolanaEventValidator,
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
    });

    await validator.validate(createEvent());
  });

  it("throws when transaction is missing", async () => {
    const validator = createSolanaEventValidator({
      getTransaction: async () => null,
      logger: {
        warn: () => {},
      },
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

  it("registers the validator plugin", async (t) => {
    const app = fastify({ logger: false });
    app.register(
      fp(async (instance) => {
        instance.decorate(kEnvConfig, { SOLANA_RPC_URL: "http://localhost:8899" });
      }, { name: "env" })
    );
    t.mock.method(Connection.prototype, "getTransaction", async () => null);
    app.register(solanaEventsValidatorPlugin);
    await app.ready();

    const validator = app.getDecorator(kSolanaEventValidator);
    t.assert.ok(validator);
    await assert.rejects(() => validator.validate(createEvent()), /Transaction not found/);
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
    });

    await assert.rejects(
      () => validator.validate(createEvent()),
      /do not match/
    );
  });
});
