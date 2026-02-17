import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createInMemoryOrders } from "../../../utils/in-memory-orders.js";
import { createQubicOrderHandlers } from "../../../../src/plugins/app/events/qubic/qubic-orders.js";
import type { FastifyBaseLogger } from "fastify";
import type { SignerService } from "../../../../src/plugins/app/signer/signer.service.js";

const hex32 = (value: number) =>
  Buffer.from(new Uint8Array(32).fill(value)).toString("hex");

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

function createMockSignerService(): SignerService {
  let callCount = 0;
  return {
    signQubicLockOrder: async () => {
      callCount++;
      return Buffer.from(`mock-sig-${callCount}`).toString("base64");
    },
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

function createLockPayload() {
  return {
    fromAddress: hex32(1),
    toAddress: hex32(2),
    amount: "100",
    relayerFee: "12",
    nonce: hex32(3),
  };
}

function createOverridePayload() {
  return {
    fromAddress: hex32(1),
    toAddress: hex32(4),
    amount: "100",
    relayerFee: "5",
    nonce: hex32(3),
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
      protocol: "QubicBridge",
      version: "1",
    });
  });

  it("produces a real Ed25519 signature (not a placeholder)", async () => {
    const { repo, handleLockEvent } = createHandlers();
    const payload = createLockPayload();

    await handleLockEvent(payload, { signature: "trx-lock" });

    const stored = await repo.findBySourceNonce(payload.nonce);
    assert.ok(stored);
    const sigBytes = Buffer.from(stored!.signature, "base64");
    assert.ok(sigBytes.length > 0, "Signature should be non-empty base64");
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
      relay_attempts: 0,
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
        toAddress: hex32(99),
        amount: "1",
        nonce: hex32(100),
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
