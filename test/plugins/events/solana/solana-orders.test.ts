import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFailedOrderFromOutboundEvent,
  createSolanaOrderHandlers,
} from "../../../../src/plugins/app/events/solana/solana-orders.js";
import { bytesToHex, hex32 } from "../../../../src/plugins/app/common/bytes.js";
import { createInMemoryOrders } from "../../../helpers/factories/in-memory-orders.js";
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
    discriminator: 1,
    networkIn: 1,
    networkOut: 1,
    tokenIn: new Uint8Array(32).fill(1),
    tokenOut: new Uint8Array(32).fill(2),
    fromAddress: new Uint8Array(32).fill(3),
    toAddress: new Uint8Array(32).fill(4),
    amount: 10_000_000_000n,
    relayerFee: 2_000_000_000n,
    nonce,
    orderEra: 0,
  };
}

function createOverrideEvent() {
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return {
    discriminator: 2,
    toAddress: new Uint8Array(32).fill(9),
    relayerFee: 7_000_000_000n,
    nonce,
  };
}

function createHandlers(repo: Repo) {
  const { logger, entries } = createLogger();
  const signerService = {
    signLockOrderForSolana: async () => "signed-solana-order",
    signUnlockOrderForQubic: async () => "signed-qubic-order",
  };
  const validation = createValidation();
  const relayerFeeAcceptance = {
    acceptRelayToSolana: () => true,
    acceptRelayToQubic: () => true,
  };
  return {
    ...createSolanaOrderHandlers({
      ordersRepository: repo as never,
      signerService,
      logger,
      validation,
      relayerFeeAcceptance,
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
    assert.strictEqual(stored.signature, "signed-qubic-order");
    assert.strictEqual(stored.origin_trx_hash, "sig-create-order");
    assert.strictEqual(stored.oracle_accept_to_relay, true);

    const sourcePayload = JSON.parse(stored.source_payload ?? "{}");
    assert.deepStrictEqual(sourcePayload, {
      v: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: bytesToHex(event.tokenIn),
      tokenOut: bytesToHex(event.tokenOut),
      nonce: bytesToHex(event.nonce),
      orderEra: 0,
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
        relay_attempts: 0,
        source_nonce: existingNonce,
        source_payload: JSON.stringify({ v: 1, networkIn: 1, networkOut: 1, tokenIn: hex32(1), tokenOut: hex32(2), nonce: existingNonce, orderEra: 0 }),
        order_era: 0,
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
      relay_attempts: 0,
      source_nonce: overrideNonce,
      source_payload: JSON.stringify({ v: 1, networkIn: 1, networkOut: 1, tokenIn: hex32(1), tokenOut: hex32(2), nonce: overrideNonce, orderEra: 0 }),
      order_era: 0,
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
      relay_attempts: 0,
      source_nonce: overrideNonce,
      source_payload: JSON.stringify({ v: 2, networkIn: 1, networkOut: 1, tokenIn: hex32(1), tokenOut: hex32(2), nonce: overrideNonce, orderEra: 0 }),
      order_era: 0,
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
      relay_attempts: 0,
      source_nonce: overrideNonce,
      source_payload: "{bad",
      order_era: 0,
    });

    await handleOverrideOutboundEvent(overrideEvent);
    assert.ok(
      entries.some((entry) => entry.message?.includes("override event"))
    );
  });

  it("skips override events for finalized orders", async () => {
    const repo = createInMemoryOrders();
    const { handleOverrideOutboundEvent, entries } = createHandlers(repo);
    const overrideEvent = createOverrideEvent();
    const overrideNonce = bytesToHex(overrideEvent.nonce);
    repo.store.set("00000000-0000-4000-8000-000000000006", {
      id: "00000000-0000-4000-8000-000000000006",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: "1",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "finalized",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: overrideNonce,
      source_payload: JSON.stringify({
        v: 1,
        networkIn: 1,
        networkOut: 1,
        tokenIn: hex32(1),
        tokenOut: hex32(2),
        nonce: overrideNonce,
        orderEra: 0,
      }),
      order_era: 0,
    });

    await handleOverrideOutboundEvent(overrideEvent);

    const stored = await repo.findBySourceNonce(overrideNonce);
    assert.ok(stored);
    assert.strictEqual(stored.to, "bb");
    assert.ok(
      entries.some((entry) => entry.message?.includes("order is finalized"))
    );
  });

  it("updates orders for override events with resigning and acceptance", async () => {
    const repo = createInMemoryOrders();
    const relayerFeeAcceptance = {
      acceptRelayToSolana: () => true,
      acceptRelayToQubic: (_amount: bigint, relayerFee: bigint) =>
        relayerFee >= 5n,
    };
    const { handleOutboundEvent, handleOverrideOutboundEvent } =
      createSolanaOrderHandlers({
        ordersRepository: repo as never,
        signerService: { signLockOrderForSolana: async () => "resigned-sig", signUnlockOrderForQubic: async () => "resigned-qubic-sig" },
        logger: createLogger().logger,
        validation: createValidation(),
        relayerFeeAcceptance,
      });

    const outbound = createOutboundEvent();
    await handleOutboundEvent(outbound, { signature: "sig-override" });

    const override = createOverrideEvent();
    await handleOverrideOutboundEvent(override);

    const stored = await repo.findBySourceNonce(bytesToHex(override.nonce));
    assert.ok(stored);
    assert.ok(stored.signature.length > 0, "signature must be non-empty");
    assert.strictEqual(stored.to, bytesToHex(override.toAddress));
    assert.strictEqual(stored.relayerFee, "7");
    assert.strictEqual(stored.oracle_accept_to_relay, true);
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
      orderEra: 0,
    });

    const parsed = parseSourcePayload(payload);
    assert.ok(parsed);
    assert.strictEqual(parsed?.tokenIn, hex32(1));
    assert.strictEqual(parseSourcePayload(undefined), null);
  });

  it("finalizes order when inbound event with signature", async () => {
    const inboundNonce = new Uint8Array(32);
    inboundNonce[31] = 7;
    const sourceNonce = bytesToHex(inboundNonce);
    const repo = createInMemoryOrders([
      {
        id: "00000000-0000-4000-8000-000000000007",
        source: "qubic",
        dest: "solana",
        from: "id(1,2,3)",
        to: "0xabc",
        amount: "10",
        relayerFee: "1",
        origin_trx_hash: "trx-lock",
        signature: "sig",
        status: "pending",
        oracle_accept_to_relay: true,
        relay_attempts: 0,
        source_nonce: sourceNonce,
        source_payload: JSON.stringify({ v: 1 }),
        order_era: 0,
      },
    ]);
    const { handleInboundEvent } = createHandlers(repo);

    await handleInboundEvent({ nonce: inboundNonce }, { signature: "mint-tx-hash" });

    const stored = await repo.findBySourceNonce(sourceNonce);
    assert.ok(stored);
    assert.strictEqual(stored?.destination_trx_hash, "mint-tx-hash");
    assert.strictEqual(stored?.status, "finalized");
  });

  it("warns when inbound event missing signature", async () => {
    const repo = createInMemoryOrders();
    const { handleInboundEvent, entries } = createHandlers(repo);
    const nonce = new Uint8Array(32);
    nonce[31] = 8;

    await handleInboundEvent({ nonce }, {});

    const msg = (e: (typeof entries)[0]) => (typeof e.payload === "string" ? e.payload : e.message ?? "");
    assert.ok(entries.some((e) => msg(e).includes("inbound") && msg(e).includes("signature")));
  });

  it("warns when inbound event for unknown order", async () => {
    const repo = createInMemoryOrders();
    const { handleInboundEvent, entries } = createHandlers(repo);
    const nonce = new Uint8Array(32);
    nonce[31] = 9;

    await handleInboundEvent({ nonce }, { signature: "mint-tx" });

    assert.ok(entries.some((e) => e.message?.includes("unknown order")));
  });

  it("ignores inbound when order dest is not solana", async () => {
    const nonce = new Uint8Array(32);
    nonce[31] = 10;
    const sourceNonce = bytesToHex(nonce);
    const repo = createInMemoryOrders([
      {
        id: "00000000-0000-4000-8000-000000000010",
        source: "solana",
        dest: "qubic",
        from: "aa",
        to: "bb",
        amount: "1",
        relayerFee: "0",
        origin_trx_hash: "trx",
        signature: "sig",
        status: "pending",
        oracle_accept_to_relay: true,
        relay_attempts: 0,
        source_nonce: sourceNonce,
        source_payload: JSON.stringify({ v: 1 }),
        order_era: 0,
      },
    ]);
    const { handleInboundEvent } = createHandlers(repo);

    await handleInboundEvent({ nonce }, { signature: "mint-tx" });

    const stored = await repo.findBySourceNonce(sourceNonce);
    assert.ok(stored);
    assert.strictEqual(stored?.destination_trx_hash, undefined);
    assert.strictEqual(stored?.status, "pending");
  });

  it("ignores inbound when order already finalized", async () => {
    const nonce = new Uint8Array(32);
    nonce[31] = 11;
    const sourceNonce = bytesToHex(nonce);
    const repo = createInMemoryOrders([
      {
        id: "00000000-0000-4000-8000-000000000011",
        source: "qubic",
        dest: "solana",
        from: "aa",
        to: "bb",
        amount: "1",
        relayerFee: "0",
        origin_trx_hash: "trx",
        destination_trx_hash: "existing-mint",
        signature: "sig",
        status: "finalized",
        oracle_accept_to_relay: true,
        relay_attempts: 0,
        source_nonce: sourceNonce,
        source_payload: JSON.stringify({ v: 1 }),
        order_era: 0,
      },
    ]);
    const { handleInboundEvent } = createHandlers(repo);

    await handleInboundEvent({ nonce }, { signature: "new-mint-tx" });

    const stored = await repo.findBySourceNonce(sourceNonce);
    assert.ok(stored);
    assert.strictEqual(stored?.destination_trx_hash, "existing-mint");
  });
});
