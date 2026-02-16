import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryOrders } from "../../../utils/in-memory-orders.js";
import { createQubicOrderHandlers } from "../../../../src/plugins/app/events/qubic/qubic-orders.js";
import type { FastifyBaseLogger } from "fastify";

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

function createHandlers() {
  const repo = createInMemoryOrders();
  const { logger, entries } = createLogger();
  const relayerFeeAcceptance = {
    acceptRelayToSolana: (_amount: bigint, relayerFee: bigint) =>
      relayerFee >= 10n,
    acceptRelayToQubic: () => true,
  };
  return {
    repo,
    entries,
    ...createQubicOrderHandlers({
      ordersRepository: repo as never,
      logger,
      relayerFeeAcceptance,
    }),
  };
}

function createLockPayload() {
  return {
    fromAddress: "id(1,2,3,4)",
    toAddress: "0xabc",
    amount: "100",
    relayerFee: "12",
    nonce: "42",
  };
}

function createOverridePayload() {
  return {
    fromAddress: "id(1,2,3,4)",
    toAddress: "0xdef",
    amount: "100",
    relayerFee: "5",
    nonce: "42",
  };
}

describe("qubic order handlers", () => {
  it("creates a new order from lock events", async () => {
    const { repo, handleLockEvent } = createHandlers();

    const payload = createLockPayload();
    await handleLockEvent(payload, { signature: "trx-lock" });

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    assert.strictEqual(stored?.source, "qubic");
    assert.strictEqual(stored?.dest, "solana");
    assert.strictEqual(stored?.amount, payload.amount);
    assert.strictEqual(stored?.relayerFee, payload.relayerFee);
    assert.strictEqual(stored?.from, payload.fromAddress);
    assert.strictEqual(stored?.to, payload.toAddress);
    assert.strictEqual(stored?.origin_trx_hash, "trx-lock");
    assert.ok(stored?.signature);
    assert.strictEqual(stored?.oracle_accept_to_relay, true);

    const sourcePayload = JSON.parse(stored?.source_payload ?? "{}");
    assert.deepStrictEqual(sourcePayload, {
      v: 1,
      nonce: payload.nonce,
      fromAddress: payload.fromAddress,
      protocol: "qs-bridge",
      version: "1",
    });
  });

  it("skips lock events for existing orders", async () => {
    const { repo, handleLockEvent } = createHandlers();
    const payload = createLockPayload();
    await handleLockEvent(payload, { signature: "trx-lock" });
    await handleLockEvent(payload, { signature: "trx-lock-duplicate" });

    assert.strictEqual(repo.store.size, 1);
  });

  it("creates an order when signature metadata is missing", async () => {
    const { repo, handleLockEvent } = createHandlers();
    const payload = createLockPayload();

    await handleLockEvent(payload);

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    assert.strictEqual(stored?.origin_trx_hash, payload.nonce);
  });

  it("updates orders for override events", async () => {
    const { repo, handleLockEvent, handleOverrideLockEvent } = createHandlers();
    const payload = createLockPayload();
    await handleLockEvent(payload, { signature: "trx-lock" });

    const overridePayload = createOverridePayload();
    await handleOverrideLockEvent(overridePayload);

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    assert.strictEqual(stored?.to, overridePayload.toAddress);
    assert.strictEqual(stored?.relayerFee, overridePayload.relayerFee);
    assert.strictEqual(stored?.oracle_accept_to_relay, false);
  });

  it("ignores override events for finalized orders", async () => {
    const { repo, handleOverrideLockEvent, entries } = createHandlers();
    const payload = createLockPayload();
    repo.store.set("order-final", {
      id: "order-final",
      source: "qubic",
      dest: "solana",
      from: payload.fromAddress,
      to: payload.toAddress,
      amount: payload.amount,
      relayerFee: payload.relayerFee,
      origin_trx_hash: "trx-final",
      signature: "sig-final",
      status: "finalized",
      oracle_accept_to_relay: true,
      source_nonce: payload.nonce,
      source_payload: JSON.stringify({ v: 1 }),
    });

    await handleOverrideLockEvent(createOverridePayload());

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    assert.strictEqual(stored?.to, payload.toAddress);
    assert.ok(
      entries.some((entry) => entry.message?.includes("order is finalized"))
    );
  });

  it("warns when override events have no matching order", async () => {
    const { handleOverrideLockEvent, entries } = createHandlers();

    await handleOverrideLockEvent(createOverridePayload());

    assert.ok(
      entries.some((entry) => entry.message?.includes("unknown order"))
    );
  });

  it("updates destination transaction hash for unlock events", async () => {
    const { repo, handleLockEvent, handleUnlockEvent } = createHandlers();
    const payload = createLockPayload();
    await handleLockEvent(payload, { signature: "trx-lock" });

    await handleUnlockEvent(
      {
        toAddress: payload.toAddress,
        amount: payload.amount,
        nonce: payload.nonce,
      },
      { signature: "trx-unlock" }
    );

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    assert.strictEqual(stored?.destination_trx_hash, "trx-unlock");
    assert.strictEqual(stored?.status, "finalized");
  });

  it("warns when unlock events have no matching order", async () => {
    const { handleUnlockEvent, entries } = createHandlers();

    await handleUnlockEvent(
      {
        toAddress: "id(9,9,9,9)",
        amount: "1",
        nonce: "999",
      },
      { signature: "trx-unlock" }
    );

    assert.ok(
      entries.some((entry) => entry.message?.includes("unknown order"))
    );
  });

  it("warns when unlock events are missing signatures", async () => {
    const { repo, handleLockEvent, handleUnlockEvent, entries } = createHandlers();
    const payload = createLockPayload();
    await handleLockEvent(payload, { signature: "trx-lock" });

    await handleUnlockEvent({
      toAddress: payload.toAddress,
      amount: payload.amount,
      nonce: payload.nonce,
    });

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    assert.strictEqual(stored?.destination_trx_hash, undefined);
    assert.ok(
      entries.some((entry) => entry.message?.includes("missing signature"))
    );
  });
});
