import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFailedOrderFromOutboundEvent,
  createSolanaOrderHandlers,
} from "../../../../src/plugins/app/events/solana/solana-orders.js";
import { bytesToHex } from "../../../../src/plugins/app/events/solana/bytes.js";
import { createInMemoryOrders } from "../../../utils/in-memory-orders.js";
import { FastifyBaseLogger } from "fastify";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { ValidationService } from "../../../../src/plugins/app/common/validation.js";

type Repo = ReturnType<typeof createInMemoryOrders>;

function createLogger() {
  const entries: Array<{ level: string; payload: unknown; message?: string }> =
    [];
  const log = (level: string) => (payload: unknown, message?: string) => {
    entries.push({ level, payload, message });
  };
  return {
    entries,
    logger: {
      info: log("info"),
      warn: log("warn"),
      debug: log("debug"),
      error: log("error"),
    } as FastifyBaseLogger,
  };
}

function createValidation(): ValidationService {
  return {
    isValid<T>(schema: TSchema, value: unknown): value is T {
      return Value.Check(schema, value);
    },
    assertValid<T>(schema: TSchema, value: unknown, prefix: string): asserts value is T {
      if (!Value.Check(schema, value)) {
        throw new Error(`${prefix}: invalid schema`);
      }
    },
  };
}

function createOutboundEvent() {
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return {
    networkIn: 1,
    networkOut: 1,
    tokenIn: new Uint8Array(32).fill(1),
    tokenOut: new Uint8Array(32).fill(2),
    fromAddress: new Uint8Array(32).fill(3),
    toAddress: new Uint8Array(32).fill(4),
    amount: 10n,
    relayerFee: 2n,
    nonce,
  };
}

function createOverrideEvent() {
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return {
    toAddress: new Uint8Array(32).fill(9),
    relayerFee: 7n,
    nonce,
  };
}

function hex32(value: number) {
  return bytesToHex(new Uint8Array(32).fill(value));
}

function createHandlers(repo: Repo) {
  const { logger, entries } = createLogger();
  const signerService = {
    signSolanaOrder: async () => "signed-solana-order",
  };
  const validation = createValidation();
  return {
    ...createSolanaOrderHandlers({
      ordersRepository: repo as never,
      signerService,
      config: { SOLANA_BPS_FEE: 25 },
      logger,
      validation,
    }),
    logger,
    entries,
  };
}

describe("solana order handlers", () => {
  it("ignores outbound events for unsupported networks", async () => {
    const repo = createInMemoryOrders();
    const { handleOutboundEvent } = createHandlers(repo);

    const event = createOutboundEvent();
    event.networkOut = 99;
    await handleOutboundEvent(event, { signature: "sig-ignored-network" });

    assert.strictEqual(repo.store.size, 0);
  });

  it("creates a new order from outbound events", async () => {
    const repo = createInMemoryOrders();
    const { handleOutboundEvent } = createHandlers(repo);

    const event = createOutboundEvent();
    await handleOutboundEvent(event, { signature: "sig-create-order" });

    const stored = await repo.findBySourceNonce(bytesToHex(event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored.source, "solana");
    assert.strictEqual(stored.dest, "qubic");
    assert.strictEqual(stored.amount, "10");
    assert.strictEqual(stored.relayerFee, "2");
    assert.strictEqual(stored.from, bytesToHex(event.fromAddress));
    assert.strictEqual(stored.to, bytesToHex(event.toAddress));
    assert.strictEqual(stored.signature, "signed-solana-order");
    assert.strictEqual(stored.origin_trx_hash, "sig-create-order");

    const sourcePayload = JSON.parse(stored.source_payload ?? "{}");
    assert.deepStrictEqual(sourcePayload, {
      v: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: bytesToHex(event.tokenIn),
      tokenOut: bytesToHex(event.tokenOut),
      nonce: bytesToHex(event.nonce),
    });
  });

  it("creates an order when signature metadata is missing", async () => {
    const repo = createInMemoryOrders();
    const { handleOutboundEvent } = createHandlers(repo);

    const event = createOutboundEvent();
    await handleOutboundEvent(event);

    const stored = await repo.findBySourceNonce(bytesToHex(event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored.origin_trx_hash, bytesToHex(event.nonce));
  });

  it("builds failed orders when signature metadata is missing", async () => {
    const event = createOutboundEvent();
    const failed = createFailedOrderFromOutboundEvent(event, {}, "failed");

    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.origin_trx_hash, bytesToHex(event.nonce));
    assert.strictEqual(failed.signature, bytesToHex(event.nonce));
  });

  it("skips outbound events for existing orders", async () => {
    const existingNonce = bytesToHex(createOutboundEvent().nonce);
    const repo = createInMemoryOrders([
      {
        id: "00000000-0000-4000-8000-000000000001",
        source: "solana",
        dest: "qubic",
        from: "aa",
        to: "bb",
        amount: "1",
        relayerFee: "0",
        origin_trx_hash: "trx-hash",
        signature: "sig",
        status: "ready-for-relay",
        oracle_accept_to_relay: true,
        source_nonce: existingNonce,
      },
    ]);
    const { handleOutboundEvent } = createHandlers(repo);

    await handleOutboundEvent(createOutboundEvent(), { signature: "sig-existing" });

    assert.strictEqual(repo.store.size, 1);
  });

  it("warns when override events cannot be applied", async () => {
    const repo = createInMemoryOrders();
    const { handleOverrideOutboundEvent, entries } = createHandlers(repo);

    const overrideEvent = createOverrideEvent();
    const overrideNonce = bytesToHex(overrideEvent.nonce);
    await handleOverrideOutboundEvent(overrideEvent);

    repo.store.clear();
    repo.store.set("00000000-0000-4000-8000-000000000002", {
      id: "00000000-0000-4000-8000-000000000002",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: "1",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: overrideNonce,
    });

    await handleOverrideOutboundEvent(overrideEvent);

    repo.store.clear();
    repo.store.set("00000000-0000-4000-8000-000000000003", {
      id: "00000000-0000-4000-8000-000000000003",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: "1",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: overrideNonce,
      source_payload: JSON.stringify({ v: 2 }),
    });

    await handleOverrideOutboundEvent(overrideEvent);

    repo.store.clear();
    repo.store.set("00000000-0000-4000-8000-000000000004", {
      id: "00000000-0000-4000-8000-000000000004",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: "1",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: overrideNonce,
      source_payload: "{bad",
    });

    await handleOverrideOutboundEvent(overrideEvent);
    assert.ok(
      entries.some((entry) => entry.message?.includes("override event"))
    );
  });

  it("updates orders for override events without resigning", async () => {
    const repo = createInMemoryOrders();
    let signerCalls = 0;
    const { logger } = createLogger();
    const signerService = {
      signSolanaOrder: async () => {
        signerCalls += 1;
        return "signed-solana-order";
      },
    };
    const { handleOutboundEvent, handleOverrideOutboundEvent } =
      createSolanaOrderHandlers({
        ordersRepository: repo as never,
        signerService,
        config: { SOLANA_BPS_FEE: 25 },
        logger,
        validation: createValidation(),
      });

    const outbound = createOutboundEvent();
    await handleOutboundEvent(outbound, { signature: "sig-override" });

    const override = createOverrideEvent();
    await handleOverrideOutboundEvent(override);

    const stored = await repo.findBySourceNonce(bytesToHex(override.nonce));
    assert.ok(stored);
    assert.strictEqual(stored.signature, "signed-solana-order");
    assert.strictEqual(stored.to, bytesToHex(override.toAddress));
    assert.strictEqual(stored.relayerFee, "7");
    assert.strictEqual(signerCalls, 1);
  });

  it("parses source payloads through handlers", () => {
    const repo = createInMemoryOrders();
    const { parseSourcePayload } = createHandlers(repo);
    const payload = JSON.stringify({
      v: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: hex32(1),
      tokenOut: hex32(2),
      nonce: hex32(3),
    });

    const parsed = parseSourcePayload(payload);
    assert.ok(parsed);
    assert.strictEqual(parsed?.tokenIn, hex32(1));
    assert.strictEqual(parseSourcePayload(undefined), null);
  });
});
