import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSolanaOrderHandlers,
} from "../../../../src/plugins/app/events/solana/solana-orders.js";
import { bytesToHex } from "../../../../src/plugins/app/events/solana/bytes.js";
import { createInMemoryOrders } from "../../../utils/in-memory-orders.js";
import { FastifyBaseLogger } from "fastify";

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

function createHandlers(repo: Repo) {
  const { logger, entries } = createLogger();
  const signerService = {
    signSolanaOrder: async () => "signed-solana-order",
  };
  return {
    ...createSolanaOrderHandlers({
      ordersRepository: repo as never,
      signerService,
      config: { SOLANA_BPS_FEE: 25 },
      logger,
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

  it("updates orders for override events", async () => {
    const repo = createInMemoryOrders();
    const { handleOutboundEvent, handleOverrideOutboundEvent } =
      createHandlers(repo);

    const outbound = createOutboundEvent();
    await handleOutboundEvent(outbound, { signature: "sig-override" });

    const override = createOverrideEvent();
    await handleOverrideOutboundEvent(override);

    const stored = await repo.findBySourceNonce(bytesToHex(override.nonce));
    assert.ok(stored);
    assert.strictEqual(stored.signature, "signed-solana-order");
    assert.strictEqual(stored.to, bytesToHex(override.toAddress));
    assert.strictEqual(stored.relayerFee, "7");
  });
});
