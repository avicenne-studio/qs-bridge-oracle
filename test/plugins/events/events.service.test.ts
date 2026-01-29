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
        createdAt: new Date().toISOString(),
      },
    ],
    cursor: 1,
  };
}

function createOverrideEventResponse() {
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
        createdAt: new Date().toISOString(),
      },
    ],
    cursor: 2,
  };
}

function createOutboundEventBytes() {
  const encoder = getOutboundEventEncoder();
  return new Uint8Array(
    encoder.encode({
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
      buildHubEventsPath(5, 10),
      "/api/orders/events?after=5&limit=10"
    );
  });

  it("processes valid events and creates orders", async (t) => {
    process.env.HUB_URLS = HUB_URLS;
    const response = createOutboundEventResponse();
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

    const app = await build(t);
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);

    let stored: StoredOrder = null;
    await waitFor(async () => {
      stored = await repo.findBySourceNonce(hex32(1));
      return Boolean(stored);
    });
    assert.ok(stored);
    assert.ok(stored && stored.signature);
    assert.ok(txMock.calls.length > 0);
  });

  it("logs when payload is invalid", async (t) => {
    process.env.HUB_URLS = HUB_URLS;
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

  it("logs when processing fails", async (t) => {
    process.env.HUB_URLS = HUB_URLS;
    const response = createOutboundEventResponse();
    let errorMock: MockMethod | null = null;

    t.mock.method(Connection.prototype, "getTransaction", async () => {
      return {
        meta: { err: "boom", logMessages: [] },
      } as never;
    });

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
      beforeRegister: (instance) => {
        errorMock = t.mock.method(instance.log, "error").mock;
      },
    });

    await waitFor(
      () =>
        Boolean(
          errorMock?.calls.some(
            (call) => call.arguments[1] === "Failed to process hub event"
          )
        ),
      2_000
    );
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const stored = await repo.findBySourceNonce(hex32(1));
    assert.strictEqual(stored, null);
  });

  it("processes override events", async (t) => {
    process.env.HUB_URLS = HUB_URLS;
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

    const existingOrder: OracleOrder = {
      id: "00000000-0000-4000-8000-000000000009",
      source: "solana",
      dest: "qubic",
      from: hex32(1),
      to: hex32(2),
      amount: "10",
      relayerFee: "1",
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

    let response: unknown = { data: [], cursor: 0 };
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

    const app = await build(t);
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
    process.env.HUB_URLS = HUB_URLS;
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

    const app = await build(t);
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    let stored: StoredOrder = null;
    await waitFor(async () => {
      stored = await repo.findBySourceNonce(hex32(1));
      return Boolean(stored);
    });
    assert.ok(stored);
  });
});
