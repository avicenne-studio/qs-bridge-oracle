import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSolanaOrderHandlers,
} from "../../../../src/plugins/app/listener/solana/solana-orders.js";
import { bytesToHex } from "../../../../src/plugins/app/listener/solana/bytes.js";
import { type OracleOrder } from "../../../../src/plugins/app/indexer/schemas/order.js";
import { type SolanaOrderToSign } from "../../../../src/plugins/app/signer/signer.service.js";

type Repo = ReturnType<typeof createInMemoryOrders>;

function createInMemoryOrders(initial: OracleOrder[] = []) {
  const store = new Map<string, OracleOrder>();
  for (const order of initial) {
    store.set(order.id, order);
  }
  return {
    store,
    async findById(id: string) {
      return store.get(id) ?? null;
    },
    async findBySourceNonce(sourceNonce: string) {
      for (const order of store.values()) {
        if (order.source_nonce === sourceNonce) {
          return order;
        }
      }
      return null;
    },
    async create(order: OracleOrder) {
      store.set(order.id, order);
      return order;
    },
    async update(id: string, changes: Partial<OracleOrder>) {
      const existing = store.get(id);
      if (!existing) {
        return null;
      }
      const updated = { ...existing, ...changes };
      store.set(id, updated);
      return updated;
    },
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
      error: log("error"),
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

function createHandlers(repo: Repo, signerCalls: SolanaOrderToSign[]) {
  const { logger, entries } = createLogger();
  return {
    ...createSolanaOrderHandlers({
      ordersRepository: repo,
      signerService: {
        async signSolanaOrder(order) {
          signerCalls.push(order);
          return `sig-${signerCalls.length}`;
        },
      },
      config: { SOLANA_BPS_FEE: 25 },
      logger,
      contractAddressBytes: new Uint8Array(32).fill(8),
    }),
    logger,
    entries,
  };
}

describe("solana order handlers", () => {
  it("ignores outbound events for unsupported networks", async () => {
    const repo = createInMemoryOrders();
    const signerCalls: SolanaOrderToSign[] = [];
    const { handleOutboundEvent } = createHandlers(repo, signerCalls);

    const event = createOutboundEvent();
    event.networkOut = 99;
    await handleOutboundEvent(event);

    assert.strictEqual(repo.store.size, 0);
    assert.strictEqual(signerCalls.length, 0);
  });

  it("creates a new order from outbound events", async () => {
    const repo = createInMemoryOrders();
    const signerCalls: SolanaOrderToSign[] = [];
    const { handleOutboundEvent } = createHandlers(repo, signerCalls);

    const event = createOutboundEvent();
    await handleOutboundEvent(event);

    const stored = await repo.findBySourceNonce(bytesToHex(event.nonce));
    assert.ok(stored);
    assert.strictEqual(stored.source, "solana");
    assert.strictEqual(stored.dest, "qubic");
    assert.strictEqual(stored.signature, "sig-1");
    assert.strictEqual(stored.amount, 10);
    assert.strictEqual(stored.relayerFee, 2);
    assert.strictEqual(stored.from, bytesToHex(event.fromAddress));
    assert.strictEqual(stored.to, bytesToHex(event.toAddress));

    const sourcePayload = JSON.parse(stored.source_payload ?? "{}");
    assert.deepStrictEqual(sourcePayload, {
      v: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: bytesToHex(event.tokenIn),
      tokenOut: bytesToHex(event.tokenOut),
      nonce: bytesToHex(event.nonce),
    });

    assert.strictEqual(signerCalls.length, 1);
    assert.deepStrictEqual(signerCalls[0], {
      protocolName: "qs-bridge",
      protocolVersion: "1",
      contractAddress: new Uint8Array(32).fill(8),
      networkIn: 1,
      networkOut: 1,
      tokenIn: new Uint8Array(event.tokenIn),
      tokenOut: new Uint8Array(event.tokenOut),
      fromAddress: new Uint8Array(event.fromAddress),
      toAddress: new Uint8Array(event.toAddress),
      amount: 10n,
      relayerFee: 2n,
      bpsFee: 25,
      nonce: new Uint8Array(event.nonce),
    });
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
        amount: 1,
        relayerFee: 0,
        signature: "sig",
        status: "ready-for-relay",
        oracle_accept_to_relay: true,
        source_nonce: existingNonce,
      },
    ]);
    const signerCalls: SolanaOrderToSign[] = [];
    const { handleOutboundEvent } = createHandlers(repo, signerCalls);

    await handleOutboundEvent(createOutboundEvent());

    assert.strictEqual(repo.store.size, 1);
    assert.strictEqual(signerCalls.length, 0);
  });

  it("warns when override events cannot be applied", async () => {
    const repo = createInMemoryOrders();
    const signerCalls: SolanaOrderToSign[] = [];
    const { handleOverrideOutboundEvent, entries } = createHandlers(
      repo,
      signerCalls
    );

    const overrideEvent = createOverrideEvent();
    const overrideNonce = bytesToHex(overrideEvent.nonce);
    await handleOverrideOutboundEvent(overrideEvent);
    assert.strictEqual(signerCalls.length, 0);

    repo.store.clear();
    repo.store.set("00000000-0000-4000-8000-000000000002", {
      id: "00000000-0000-4000-8000-000000000002",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: 1,
      relayerFee: 0,
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: overrideNonce,
    });

    await handleOverrideOutboundEvent(overrideEvent);
    assert.strictEqual(signerCalls.length, 0);

    repo.store.clear();
    repo.store.set("00000000-0000-4000-8000-000000000003", {
      id: "00000000-0000-4000-8000-000000000003",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: 1,
      relayerFee: 0,
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: overrideNonce,
      source_payload: JSON.stringify({ v: 2 }),
    });

    await handleOverrideOutboundEvent(overrideEvent);
    assert.strictEqual(signerCalls.length, 0);

    repo.store.clear();
    repo.store.set("00000000-0000-4000-8000-000000000004", {
      id: "00000000-0000-4000-8000-000000000004",
      source: "solana",
      dest: "qubic",
      from: "aa",
      to: "bb",
      amount: 1,
      relayerFee: 0,
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: overrideNonce,
      source_payload: "{bad",
    });

    await handleOverrideOutboundEvent(overrideEvent);
    assert.strictEqual(signerCalls.length, 0);
    assert.ok(
      entries.some((entry) => entry.message?.includes("override event"))
    );
  });

  it("updates orders for override events", async () => {
    const repo = createInMemoryOrders();
    const signerCalls: SolanaOrderToSign[] = [];
    const { handleOutboundEvent, handleOverrideOutboundEvent } = createHandlers(
      repo,
      signerCalls
    );

    const outbound = createOutboundEvent();
    await handleOutboundEvent(outbound);

    const override = createOverrideEvent();
    await handleOverrideOutboundEvent(override);

    const stored = await repo.findBySourceNonce(bytesToHex(override.nonce));
    assert.ok(stored);
    assert.strictEqual(stored.signature, "sig-2");
    assert.strictEqual(stored.to, bytesToHex(override.toAddress));
    assert.strictEqual(stored.relayerFee, 7);
    assert.strictEqual(signerCalls.length, 2);
    assert.strictEqual(
      (signerCalls[1].toAddress as Uint8Array)[0],
      override.toAddress[0]
    );
  });
});
