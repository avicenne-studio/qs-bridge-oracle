import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import wsSolanaListener, {
  createDefaultSolanaWsFactory,
  resolveSolanaWsFactory,
} from "../../../../src/plugins/app/listener/solana/ws-solana-listener.js";
import { waitFor } from "../../../helper.js";
import { getOutboundEventEncoder } from "../../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../../src/clients/js/types/overrideOutboundEvent.js";
import { type OracleOrder } from "../../../../src/plugins/app/indexer/schemas/order.js";
import { type SolanaOrderToSign } from "../../../../src/plugins/app/signer/signer.service.js";
import { kEnvConfig } from "../../../../src/plugins/infra/env.js";
import { kOrdersRepository } from "../../../../src/plugins/app/indexer/orders.repository.js";
import { kSignerService } from "../../../../src/plugins/app/signer/signer.service.js";

type WsEventMap = {
  open: Record<string, never>;
  close: Record<string, never>;
  error: { data?: unknown };
  message: { data?: unknown };
};

type WsEventHandler = (event: WsEventMap[keyof WsEventMap]) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<keyof WsEventMap, Set<WsEventHandler>>();

  addEventListener<K extends keyof WsEventMap>(
    type: K,
    listener: (event: WsEventMap[K]) => void
  ) {
    const bucket = this.listeners.get(type) ?? new Set<WsEventHandler>();
    bucket.add(listener as WsEventHandler);
    this.listeners.set(type, bucket);
  }

  removeEventListener<K extends keyof WsEventMap>(
    type: K,
    listener: (event: WsEventMap[K]) => void
  ) {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    bucket.delete(listener);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  emit<K extends keyof WsEventMap>(type: K, event: WsEventMap[K]) {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    for (const handler of bucket) {
      handler(event);
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", {});
  }
}

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
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
      nonce,
    })
  );
}

function createOverrideEventBytes() {
  const encoder = getOverrideOutboundEventEncoder();
  const nonce = new Uint8Array(32);
  nonce[31] = 1;
  return new Uint8Array(
    encoder.encode({
      toAddress: new Uint8Array(32).fill(9),
      relayerFee: 7n,
      nonce,
    })
  );
}

function createLogsNotification(lines: string[]) {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      result: {
        value: { err: null, logs: lines },
      },
    },
  });
}

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

type ListenerAppOptions = {
  enabled?: boolean;
  ws?: MockWebSocket;
  signerImpl?: (order: SolanaOrderToSign) => Promise<string>;
};

async function buildListenerApp({
  enabled = true,
  ws = new MockWebSocket(),
  signerImpl,
}: ListenerAppOptions = {}) {
  const app = fastify({ logger: false });
  const ordersRepository = createInMemoryOrders();
  const signerCalls: SolanaOrderToSign[] = [];

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kEnvConfig, {
          SOLANA_LISTENER_ENABLED: enabled,
          SOLANA_WS_URL: "ws://localhost:8900",
          SOLANA_BPS_FEE: 25,
        });
      },
      { name: "env" }
    )
  );

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kSignerService, {
          async signSolanaOrder(order: SolanaOrderToSign) {
            signerCalls.push(order);
            if (signerImpl) {
              return signerImpl(order);
            }
            return `sig-${signerCalls.length}`;
          },
        });
      },
      { name: "signer-service" }
    )
  );

  app.register(
    fp(
      async (instance) => {
        instance.decorate(kOrdersRepository, ordersRepository);
      },
      { name: "orders-repository" }
    )
  );

  app.decorate("solanaWsFactory", () => ws);
  app.register(wsSolanaListener);
  await app.ready();

  return { app, ws, ordersRepository, signerCalls };
}

describe("ws solana listener plugin", () => {
  it("skips initialization when disabled", async () => {
    let created = 0;
    const ws = new MockWebSocket();
    const app = fastify({ logger: false });

    app.register(
      fp(async (instance) => {
        instance.decorate(kEnvConfig, {
          SOLANA_LISTENER_ENABLED: false,
          SOLANA_WS_URL: "ws://localhost:8900",
          SOLANA_BPS_FEE: 25,
        });
      }, { name: "env" })
    );
    app.register(
      fp(async (instance) => {
        instance.decorate(kSignerService, { signSolanaOrder: async () => "sig" });
      }, { name: "signer-service" })
    );
    app.register(
      fp(async (instance) => {
        instance.decorate(kOrdersRepository, createInMemoryOrders());
      }, { name: "orders-repository" })
    );
    app.decorate("solanaWsFactory", () => {
      created += 1;
      return ws;
    });

    app.register(wsSolanaListener);
    await app.ready();
    await app.close();

    assert.strictEqual(created, 0);
  });

  it("subscribes and unsubscribes via json-rpc", async () => {
    const { app, ws } = await buildListenerApp();

    ws.emit("open", {});
    const subscribe = JSON.parse(ws.sent[0]);
    assert.strictEqual(subscribe.method, "logsSubscribe");
    ws.emit(
      "message",
      {
        data: JSON.stringify({
          jsonrpc: "2.0",
          id: subscribe.id,
          result: 55,
        }),
      }
    );

    await app.close();

    const unsubscribe = ws.sent.find((payload) =>
      payload.includes("logsUnsubscribe")
    );
    assert.ok(unsubscribe);
    const parsed = JSON.parse(unsubscribe);
    assert.deepStrictEqual(parsed.params, [55]);
  });

  it("handles shutdown before ws initialization", async () => {
    const app = fastify({ logger: false });
    app.register(
      fp(async (instance) => {
        instance.decorate(kEnvConfig, {
          SOLANA_LISTENER_ENABLED: true,
          SOLANA_WS_URL: "ws://localhost:8900",
          SOLANA_BPS_FEE: 25,
        });
      }, { name: "env" })
    );
    app.register(
      fp(async (instance) => {
        instance.decorate(kSignerService, { signSolanaOrder: async () => "sig" });
      }, { name: "signer-service" })
    );
    app.register(
      fp(async (instance) => {
        instance.decorate(kOrdersRepository, createInMemoryOrders());
      }, { name: "orders-repository" })
    );
    app.register(wsSolanaListener);

    await app.close();
  });

  it("logs failures while processing queued events", async () => {
    const { app, ws, signerCalls } = await buildListenerApp({
      signerImpl: async () => {
        throw new Error("boom");
      },
    });

    ws.emit("open", {});

    const outboundBytes = createOutboundEventBytes();
    const payload = createLogsNotification([
      `Program data: ${Buffer.from(outboundBytes).toString("base64")}`,
    ]);
    ws.emit("message", { data: payload });

    await waitFor(() => signerCalls.length === 1);

    await app.close();
  });

  it("clears subscription state on close events", async () => {
    const { app, ws } = await buildListenerApp();

    ws.emit("open", {});
    const subscribe = JSON.parse(ws.sent[0]);
    ws.emit("message", {
      data: JSON.stringify({
        jsonrpc: "2.0",
        id: subscribe.id,
        result: 55,
      }),
    });
    ws.emit("close", {});

    await app.close();
  });

  it("processes outbound and override events", async () => {
    const { app, ws, ordersRepository, signerCalls } = await buildListenerApp();

    ws.emit("open", {});

    const outboundBytes = createOutboundEventBytes();
    const overrideBytes = createOverrideEventBytes();
    const payload = createLogsNotification([
      `Program data: ${Buffer.from(outboundBytes).toString("base64")}`,
      `Program data: ${Buffer.from(overrideBytes).toString("base64")}`,
      `Program data: ${Buffer.from(new Uint8Array(12)).toString("base64")}`,
      `Program data: ${Buffer.from(new Uint8Array(12)).toString("base64")}`,
    ]);

    ws.emit("message", { data: payload });
    ws.emit(
      "message",
      { data: JSON.stringify({ jsonrpc: "2.0", method: "ping" }) }
    );
    ws.emit(
      "message",
      {
        data: JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: { result: { value: { err: "boom", logs: [] } } },
        }),
      }
    );
    ws.emit("error", { data: "boom" });
    ws.emit("message", { data: "{bad json" });

    await waitFor(() =>
      [...ordersRepository.store.values()].some(
        (order) => order.signature === "sig-2"
      )
    );

    const stored = [...ordersRepository.store.values()].find(
      (order) => order.signature === "sig-2"
    );
    assert.ok(stored);
    assert.strictEqual(stored.relayerFee, 7);
    assert.strictEqual(signerCalls.length, 2);

    await app.close();
  });

  it("resolves factories with explicit overrides", () => {
    class FakeWebSocket {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    }

    type DefaultFactoryArg = Parameters<typeof createDefaultSolanaWsFactory>[0];
    type ResolveInput = Parameters<typeof resolveSolanaWsFactory>[0];

    const defaultFactory = createDefaultSolanaWsFactory(
      FakeWebSocket as unknown as DefaultFactoryArg
    );
    const override = () => new MockWebSocket();
    const resolved = resolveSolanaWsFactory(
      { solanaWsFactory: override } as ResolveInput,
      defaultFactory
    );
    assert.strictEqual(resolved, override);

    const parentFactory = () => new MockWebSocket();
    const resolvedParent = resolveSolanaWsFactory(
      { parent: { solanaWsFactory: parentFactory } } as ResolveInput,
      defaultFactory
    );
    assert.strictEqual(resolvedParent, parentFactory);

    const resolvedDefault = resolveSolanaWsFactory(
      {} as ResolveInput,
      defaultFactory
    );
    assert.strictEqual(resolvedDefault, defaultFactory);

    const fromDefault = defaultFactory("ws://example.test");
    assert.ok(fromDefault instanceof FakeWebSocket);
  });
});
