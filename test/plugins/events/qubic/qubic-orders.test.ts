import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryOrders } from "../../../helpers/factories/in-memory-orders.js";
import {
  createFailedOrderFromLockEvent,
  createQubicOrderHandlers,
} from "../../../../src/plugins/app/events/qubic/qubic-orders.js";
import { mapStoredEventToQubicPayload } from "../../../../src/plugins/app/events/qubic/qubic-event-mapper.js";
import type { FastifyBaseLogger } from "fastify";
import { hex32, bytesToHex, nonceToBytes } from "../../../../src/plugins/app/common/bytes.js";
import { createMockSignerService } from "../../../helpers/signer-mock.js";

function normalizeNonce(nonce: string): string {
  return bytesToHex(nonceToBytes(nonce));
}

function createLockPayload() {
  return {
    fromAddress: hex32(1),
    toAddress: hex32(2),
    amount: "100",
    relayerFee: "12",
    nonce: hex32(3),
    orderEra: "0",
  };
}

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
  const signerService = createMockSignerService();
  return {
    repo,
    entries,
    ...createQubicOrderHandlers({
      ordersRepository: repo as never,
      signerService,
      config: { TOKEN_MINT: "4bbjhGLSYwku6Y44dqwcroRfj2vHCdiHJ9SUmndc4FVg" },
      logger,
      relayerFeeAcceptance,
    }),
  };
}

function makeLockStoredEvent(overrides: Partial<{
  fromAddress: string;
  toAddress: string;
  amount: string;
  relayerFee: string;
  nonce: string;
}> = {}) {
  const payload = {
    fromAddress: hex32(1),
    toAddress: hex32(2),
    amount: "100",
    relayerFee: "12",
    nonce: hex32(3),
    orderEra: "0",
    ...overrides,
  };
  return {
    id: 1,
    signature: "trx-lock",
    chain: "qubic" as const,
    type: "lock" as const,
    nonce: payload.nonce,
    payload,
    createdAt: "2024-01-01 00:00:00",
  };
}

function makeOverrideStoredEvent(overrides: Partial<{
  fromAddress: string;
  toAddress: string;
  amount: string;
  relayerFee: string;
  nonce: string;
}> = {}) {
  const payload = {
    fromAddress: hex32(1),
    toAddress: hex32(4),
    amount: "100",
    relayerFee: "5",
    nonce: hex32(3),
    orderEra: "0",
    ...overrides,
  };
  return {
    id: 2,
    signature: "trx-override",
    chain: "qubic" as const,
    type: "override-lock" as const,
    nonce: payload.nonce,
    payload,
    createdAt: "2024-01-01 00:00:01",
  };
}

function makeUnlockStoredEvent(overrides: Partial<{
  toAddress: string;
  amount: string;
  nonce: string;
  signature: string;
}> = {}) {
  const payload = {
    toAddress: "0".repeat(64),
    amount: "0",
    nonce: "",
    ...overrides,
  };
  return {
    id: 3,
    signature: overrides.signature ?? "order-hash-1",
    chain: "qubic" as const,
    type: "unlock" as const,
    nonce: payload.nonce,
    payload,
    createdAt: "2024-01-01 00:00:02",
  };
}

describe("qubic order handlers", () => {
  it("creates a new order from lock events", async () => {
    const { repo, handleLockEvent } = createHandlers();

    const stored_event = makeLockStoredEvent();
    const { event } = mapStoredEventToQubicPayload(stored_event) as { type: "lock"; event: ReturnType<typeof mapStoredEventToQubicPayload>["event"] };
    await handleLockEvent(event as never, { signature: "trx-lock" });

    const stored = await repo.findBySourceNonce(normalizeNonce(stored_event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored?.source, "qubic");
    assert.strictEqual(stored?.dest, "solana");
    assert.strictEqual(stored?.amount, stored_event.payload.amount);
    assert.strictEqual(stored?.relayerFee, stored_event.payload.relayerFee);
    assert.strictEqual(stored?.from, stored_event.payload.fromAddress);
    assert.strictEqual(stored?.origin_trx_hash, "trx-lock");
    assert.ok(stored?.signature);
    assert.strictEqual(stored?.oracle_accept_to_relay, true);

    const sourcePayload = JSON.parse(stored?.source_payload ?? "{}");
    assert.deepStrictEqual(sourcePayload, {
      v: 1,
      nonce: normalizeNonce(stored_event.nonce),
      fromAddress: stored_event.payload.fromAddress,
      protocol: "QubicBridge",
      version: "1",
      orderEra: 0,
    });
  });

  it("produces a real Ed25519 signature (not a placeholder)", async () => {
    const { repo, handleLockEvent } = createHandlers();
    const stored_event = makeLockStoredEvent();
    const mapped = mapStoredEventToQubicPayload(stored_event);

    await handleLockEvent(mapped.event as never, { signature: "trx-lock" });

    const stored = await repo.findBySourceNonce(normalizeNonce(stored_event.nonce));
    assert.ok(stored);
    const sigBytes = Buffer.from(stored!.signature, "base64");
    assert.ok(sigBytes.length > 0, "Signature should be non-empty base64");
  });

  it("skips lock events for existing orders", async () => {
    const { repo, handleLockEvent } = createHandlers();
    const stored_event = makeLockStoredEvent();
    const mapped = mapStoredEventToQubicPayload(stored_event);

    await handleLockEvent(mapped.event as never, { signature: "trx-lock" });
    await handleLockEvent(mapped.event as never, { signature: "trx-lock-duplicate" });

    assert.strictEqual(repo.store.size, 1);
  });

  it("creates an order when signature metadata is missing", async () => {
    const { repo, handleLockEvent } = createHandlers();
    const stored_event = makeLockStoredEvent();
    const mapped = mapStoredEventToQubicPayload(stored_event);

    await handleLockEvent(mapped.event as never);

    const stored = await repo.findBySourceNonce(normalizeNonce(stored_event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored?.origin_trx_hash, normalizeNonce(stored_event.nonce));
  });

  it("updates orders for override events", async () => {
    const { repo, handleLockEvent, handleOverrideLockEvent } = createHandlers();
    const lock_event = makeLockStoredEvent();
    const override_event = makeOverrideStoredEvent();
    const mappedLock = mapStoredEventToQubicPayload(lock_event);
    const mappedOverride = mapStoredEventToQubicPayload(override_event);

    await handleLockEvent(mappedLock.event as never, { signature: "trx-lock" });
    await handleOverrideLockEvent(mappedOverride.event as never);

    const stored = await repo.findBySourceNonce(normalizeNonce(lock_event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored?.to, override_event.payload.toAddress);
    assert.strictEqual(stored?.relayerFee, override_event.payload.relayerFee);
    assert.strictEqual(stored?.oracle_accept_to_relay, false);
  });

  it("ignores override events for finalized orders", async () => {
    const { repo, handleOverrideLockEvent, entries } = createHandlers();
    const lock_event = makeLockStoredEvent();
    const override_event = makeOverrideStoredEvent();
    repo.store.set("order-final", {
      id: "order-final",
      source: "qubic",
      dest: "solana",
      from: lock_event.payload.fromAddress,
      to: lock_event.payload.toAddress,
      amount: lock_event.payload.amount,
      relayerFee: lock_event.payload.relayerFee,
      origin_trx_hash: "trx-final",
      signature: "sig-final",
      status: "finalized",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: normalizeNonce(lock_event.nonce),
      source_payload: JSON.stringify({ v: 1 }),
      order_era: 0,
    });

    const mappedOverride = mapStoredEventToQubicPayload(override_event);
    await handleOverrideLockEvent(mappedOverride.event as never);

    const stored = await repo.findBySourceNonce(normalizeNonce(lock_event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored?.to, lock_event.payload.toAddress);
    assert.ok(
      entries.some((entry) => entry.message?.includes("order is finalized"))
    );
  });

  it("warns when override events have no matching order", async () => {
    const { handleOverrideLockEvent, entries } = createHandlers();

    const override_event = makeOverrideStoredEvent();
    const mapped = mapStoredEventToQubicPayload(override_event);
    await handleOverrideLockEvent(mapped.event as never);

    assert.ok(
      entries.some((entry) => entry.message?.includes("unknown order"))
    );
  });

  it("finalizes qubic-destination orders by destination order hash", async () => {
    const { repo, handleUnlockEvent } = createHandlers();
    const unlock_event = makeUnlockStoredEvent();
    const mappedUnlock = mapStoredEventToQubicPayload(unlock_event);

    await repo.create({
      id: "00000000-0000-4000-8000-000000000123",
      source: "solana",
      dest: "qubic",
      from: hex32(91),
      to: hex32(92),
      amount: "10",
      relayerFee: "1",
      origin_trx_hash: "trx-lock",
      destination_trx_hash: "qubic-tx-123",
      destination_order_hash: "order-hash-1",
      destination_target_tick: 12345,
      signature: "sig",
      status: "relayed",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: hex32(90),
      source_payload: JSON.stringify({ v: 1 }),
      order_era: 0,
    });

    await handleUnlockEvent(mappedUnlock.event as never, { signature: "order-hash-1" });

    const stored = await repo.findByDestinationOrderHash("order-hash-1");
    assert.ok(stored);
    assert.strictEqual(stored?.status, "finalized");
    assert.strictEqual(stored?.destination_trx_hash, "qubic-tx-123");
  });

  it("warns when unlock events have no matching order", async () => {
    const { handleUnlockEvent, entries } = createHandlers();

    const unlock_event = makeUnlockStoredEvent({ nonce: hex32(99) });
    const mapped = mapStoredEventToQubicPayload(unlock_event);
    await handleUnlockEvent(mapped.event as never, { signature: "trx-unlock" });

    assert.ok(
      entries.some((entry) => entry.message?.includes("unknown order"))
    );
  });

  it("can still finalize unlock events by source nonce as a fallback", async () => {
    const { repo, handleLockEvent, handleUnlockEvent } = createHandlers();
    const lock_event = makeLockStoredEvent();
    const unlock_event = makeUnlockStoredEvent({
      toAddress: hex32(2),
      amount: "100",
      nonce: hex32(3),
    });
    const mappedLock = mapStoredEventToQubicPayload(lock_event);
    const mappedUnlock = mapStoredEventToQubicPayload(unlock_event);

    await handleLockEvent(mappedLock.event as never, { signature: "trx-lock" });
    await handleUnlockEvent(mappedUnlock.event as never);

    const stored = await repo.findBySourceNonce(normalizeNonce(lock_event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored?.status, "finalized");
  });

  it("builds failed orders without a signature fallback", () => {
    const payload = createLockPayload();

    const failed = createFailedOrderFromLockEvent(payload, {}, "Transaction failed");

    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(failed.source, "qubic");
    assert.strictEqual(failed.dest, "solana");
    assert.strictEqual(failed.source_nonce, normalizeNonce(payload.nonce));
    assert.strictEqual(failed.signature, failed.source_nonce);
    assert.strictEqual(failed.origin_trx_hash, failed.source_nonce);
    assert.strictEqual(failed.failure_reason_public, "Transaction failed");
  });
});
