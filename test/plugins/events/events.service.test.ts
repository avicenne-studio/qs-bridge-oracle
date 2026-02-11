import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { build, waitFor } from "../../helper.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import { type OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";
import { buildHubEventsPath } from "../../../src/plugins/app/events/events.service.js";
import { Connection } from "@solana/web3.js";
import { getOutboundEventEncoder } from "../../../src/clients/js/types/outboundEvent.js";
import { getOverrideOutboundEventEncoder } from "../../../src/clients/js/types/overrideOutboundEvent.js";
import {
  kHubEventsRepository,
  type HubEventsRepository,
} from "../../../src/plugins/app/events/hub-events.repository.js";

const HUB_PRIMARY_PORT = 6201;
const HUB_FALLBACK_PORT = 6202;
const HUB_URLS = `http://127.0.0.1:${HUB_PRIMARY_PORT},http://127.0.0.1:${HUB_FALLBACK_PORT}`;
type MockMethod = { calls: Array<{ arguments: unknown[] }> };
type StoredOrder = OracleOrder | null;

const hex32 = (value: number) =>
  Buffer.from(new Uint8Array(32).fill(value)).toString("hex");

async function startHubServer(
  t: { after: (fn: () => void) => void },
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  t.after(() => server.close());
  return server;
}

function createOutboundEventResponse() {
  const createdAt = "2024-01-01 00:00:00";
  return {
    data: [
      {
        id: 1,
        signature: "sig-evt",
        slot: 10,
        chain: "solana",
        type: "outbound",
        nonce: hex32(1),
        payload: {
          networkIn: 1,
          networkOut: 1,
          tokenIn: hex32(2),
          tokenOut: hex32(3),
          fromAddress: hex32(4),
          toAddress: hex32(5),
          amount: "10",
          relayerFee: "2",
          nonce: hex32(1),
        },
        createdAt,
      },
    ],
    cursor: { createdAt, id: 1 },
  };
}

function createOverrideEventResponse() {
  const createdAt = "2024-01-01 00:00:01";
  return {
    data: [
      {
        id: 2,
        signature: "sig-override",
        slot: 11,
        chain: "solana",
        type: "override-outbound",
        nonce: hex32(9),
        payload: {
          toAddress: hex32(8),
          relayerFee: "7",
          nonce: hex32(9),
        },
        createdAt,
      },
    ],
    cursor: { createdAt, id: 2 },
  };
}

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      discriminator: 1,
      networkIn: 1,
      networkOut: 1,
      tokenIn: new Uint8Array(32).fill(2),
      tokenOut: new Uint8Array(32).fill(3),
      fromAddress: new Uint8Array(32).fill(4),
      toAddress: new Uint8Array(32).fill(5),
      amount: 10n,
      relayerFee: 2n,
      nonce: new Uint8Array(32).fill(1),
    })
  );
}

function createOverrideEventBytes() {
  const encoder = getOverrideOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
      discriminator: 2,
      toAddress: new Uint8Array(32).fill(8),
      relayerFee: 7n,
      nonce: new Uint8Array(32).fill(9),
    })
  );
}

function createLogLine(bytes: Uint8Array) {
  return `Program data: ${Buffer.from(bytes).toString("base64")}`;
}

describe("hub events service", { concurrency: 1 }, () => {
  it("builds hub events paths", () => {
    assert.strictEqual(
      buildHubEventsPath("2024-01-01T00:00:00", 5, 10),
      "/api/orders/events?created_after=2024-01-01T00%3A00%3A00&after_id=5&limit=10"
    );
  });

  it("processes valid events and creates orders", async (t) => {
    const response = createOutboundEventResponse();
    response.data[0].slot = undefined;
    const logsBySignature = new Map([
      ["sig-evt", [createLogLine(createOutboundEventBytes())]],
    ]);
    const txMock = t.mock.method(
      Connection.prototype,
      "getTransaction",
      async (signature: string) =>
        ({
          meta: {
            err: null,
            logMessages: logsBySignature.get(signature) ?? [],
          },
        }) as never
    ).mock as MockMethod;
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }));

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const app = await build(t, { useMocks: false, config: { HUB_URLS } });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const eventsRepo = app.getDecorator<HubEventsRepository>(
      kHubEventsRepository
    );

    let stored: StoredOrder = null;
    await waitFor(async () => {
      stored = await repo.findBySourceNonce(hex32(1));
      return Boolean(stored);
    }, 12_000);
    assert.ok(stored);
    assert.ok(stored && stored.signature);
    assert.ok(txMock.calls.length > 0);

    const storedEvent = await eventsRepo.findBySignature("sig-evt");
    assert.ok(storedEvent);
    assert.strictEqual(storedEvent?.status, "done");
  });

  it("logs when payload is invalid", async (t) => {
    const response = { bad: "payload" };
    let warnMock: MockMethod | null = null;

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    await build(t, {
      useMocks: false,
      config: { HUB_URLS },
      beforeRegister: (instance) => {
        warnMock = t.mock.method(instance.log, "warn").mock;
      },
    });

    await waitFor(
      () =>
        Boolean(
          warnMock?.calls.some(
            (call) => call.arguments[1] === "Invalid hub events payload"
          )
        ),
      2_000
    );
    assert.ok(warnMock);
    assert.ok(warnMock?.calls.length > 0);
  });

  it("logs when persisting hub events fails", async (t) => {
    const response = createOutboundEventResponse();
    let errorMock: MockMethod | null = null;

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const app = await build(t, { useMocks: false, config: { HUB_URLS } });
    const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
    t.mock.method(repo, "upsert", async () => {
      throw new Error("db down");
    });
    errorMock = t.mock.method(app.log, "error").mock;

    await waitFor(
      () =>
        Boolean(
          errorMock?.calls.some(
            (call) => call.arguments[1] === "Failed to persist hub event"
          )
        ),
      2_000
    );
    assert.ok(errorMock);
  });

  it("marks events failed after retries and creates failed order", async (t) => {
    const maxRetries = 1;
    const response = createOutboundEventResponse();

    t.mock.method(Connection.prototype, "getTransaction", async () => null);
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }));

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const app = await build(t, {
      useMocks: false,
      config: { HUB_URLS, SOLANA_TX_RETRY_MAX_ATTEMPTS: maxRetries },
    });
    const eventsRepo = app.getDecorator<HubEventsRepository>(
      kHubEventsRepository
    );
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);

    await waitFor(async () => {
      const failedEvent = await eventsRepo.findBySignature("sig-evt");
      return failedEvent?.status === "failed";
    }, 12_000);

    const failedOrder = await repo.findBySourceNonce(hex32(1));
    assert.ok(failedOrder);
    assert.strictEqual(failedOrder?.status, "failed");
    assert.ok(failedOrder?.failure_reason_public);
  });

  it("does not overwrite existing orders when events fail", async (t) => {
    const maxRetries = 1;

    const response = createOutboundEventResponse();
    const emptyResponse = { data: [], cursor: response.cursor };
    let shouldSendEvents = false;
    t.mock.method(Connection.prototype, "getTransaction", async () => null);
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }));

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(shouldSendEvents ? response : emptyResponse));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const app = await build(t, {
      useMocks: false,
      config: { HUB_URLS, SOLANA_TX_RETRY_MAX_ATTEMPTS: maxRetries },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    await repo.create({
      id: "00000000-0000-4000-8000-000000000010",
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig-existing",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      source_nonce: hex32(1),
    });
    shouldSendEvents = true;

    const eventsRepo = app.getDecorator<HubEventsRepository>(
      kHubEventsRepository
    );

    await waitFor(async () => {
      const failedEvent = await eventsRepo.findBySignature("sig-evt");
      return failedEvent?.status === "failed";
    }, 12_000);

    const existing = await repo.findBySourceNonce(hex32(1));
    assert.ok(existing);
    assert.strictEqual(existing?.status, "ready-for-relay");
  });

  it("processes override events", async (t) => {
    const overrideResponse = createOverrideEventResponse();
    const logsBySignature = new Map([
      ["sig-override", [createLogLine(createOverrideEventBytes())]],
    ]);
    t.mock.method(Connection.prototype, "getTransaction", async (signature: string) =>
      ({
        meta: {
          err: null,
          logMessages: logsBySignature.get(signature) ?? [],
        },
      }) as never
    );
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }));

    const existingOrder: OracleOrder = {
      id: "00000000-0000-4000-8000-000000000009",
      source: "solana",
      dest: "qubic",
      from: hex32(1),
      to: hex32(2),
      amount: "10",
      relayerFee: "1",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "pending",
      oracle_accept_to_relay: true,
      source_nonce: hex32(9),
      source_payload: JSON.stringify({
        v: 1,
        networkIn: 1,
        networkOut: 1,
        tokenIn: hex32(3),
        tokenOut: hex32(4),
        nonce: hex32(9),
      }),
    };

    let response: unknown = {
      data: [],
      cursor: { createdAt: "2024-01-01 00:00:00", id: 0 },
    };
    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const app = await build(t, { useMocks: false, config: { HUB_URLS } });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    await repo.create(existingOrder);
    response = overrideResponse;

    let stored: StoredOrder = null;
    await waitFor(async () => {
      stored = await repo.findBySourceNonce(hex32(9));
      return Boolean(stored?.relayerFee === "7");
    });
    assert.ok(stored);
    assert.strictEqual(stored?.relayerFee, "7");
  });

  it("falls back to the secondary hub when primary fails", async (t) => {
    const response = createOutboundEventResponse();
    const logsBySignature = new Map([
      ["sig-evt", [createLogLine(createOutboundEventBytes())]],
    ]);
    t.mock.method(Connection.prototype, "getTransaction", async (signature: string) =>
      ({
        meta: {
          err: null,
          logMessages: logsBySignature.get(signature) ?? [],
        },
      }) as never
    );
    t.mock.method(Connection.prototype, "getSignatureStatuses", async () => ({
      value: [{ confirmationStatus: "confirmed", err: null }],
    }));

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await startHubServer(t, HUB_FALLBACK_PORT, (req, res) => {
      if (req.url?.startsWith("/api/orders/events")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const app = await build(t, { useMocks: false, config: { HUB_URLS } });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    let stored: StoredOrder = null;
    await waitFor(async () => {
      stored = await repo.findBySourceNonce(hex32(1));
      return Boolean(stored);
    });
    assert.ok(stored);
  });
});
