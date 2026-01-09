import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build, waitFor } from "../helper.js";
import { ORDER_SIGNATURES_TABLE_NAME } from "../../src/plugins/app/indexer/orders.repository.js";

const HUB_PRIMARY_PORT = 6101;
const HUB_FALLBACK_PORT = 6102;

async function startHubServer(
  t: { after: (fn: () => void) => void },
  port: number,
  handler: Parameters<typeof createServer>[0]
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  t.after(() => server.close());
  return server;
}

describe("hub signatures polling", { concurrency: 1 }, () => {
  it("starts polling on app startup", async (t) => {
    let primaryHits = 0;

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        primaryHits += 1;
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
    t.after(() => app.close());

    await waitFor(() => primaryHits > 0);
    assert.ok(primaryHits > 0);
  });

  it("stores signatures from hub responses", async (t) => {
    let hitCount = 0;
    let payload = { data: [] as Array<unknown> };

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        hitCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
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
    t.after(() => app.close());

    const order1 = await app.ordersRepository.create({
      id: 901,
      source: "solana",
      dest: "qubic",
      from: "HubA",
      to: "HubB",
      amount: 10,
      signature: "sig-hub-1",
      status: "ready-for-relay",
      is_relayable: true,
    });
    const order2 = await app.ordersRepository.create({
      id: 902,
      source: "qubic",
      dest: "solana",
      from: "HubC",
      to: "HubD",
      amount: 20,
      signature: "sig-hub-2",
      status: "ready-for-relay",
      is_relayable: true,
    });

    payload = {
      data: [
        { orderId: order1!.id, signatures: ["sig-1"] },
        { orderId: order2!.id, signatures: ["sig-2"] },
      ],
    };

    let stored;
    await waitFor(async () => {
      if (hitCount === 0) {
        return false;
      }

      stored = await app
        .knex(ORDER_SIGNATURES_TABLE_NAME)
        .select("order_id", "signature")
        .whereIn("order_id", [order1!.id, order2!.id])
        .orderBy("order_id", "asc");

      return stored.length === 2;
    });

    assert.deepStrictEqual(stored, [
      { order_id: order1!.id, signature: "sig-1" },
      { order_id: order2!.id, signature: "sig-2" },
    ]);
  });

  it("marks orders ready when signatures meet the threshold", async (t) => {
    let hitCount = 0;
    let payload = { data: [] as Array<unknown> };

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        hitCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
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
    t.after(() => app.close());

    const order = await app.ordersRepository.create({
      id: 903,
      source: "solana",
      dest: "qubic",
      from: "HubE",
      to: "HubF",
      amount: 30,
      signature: "sig-hub-3",
      status: "ready-for-relay",
      is_relayable: false,
    });

    payload = {
      data: [{ orderId: order!.id, signatures: ["sig-3", "sig-4"] }],
    };

    let updated;
    await waitFor(async () => {
      if (hitCount === 0) {
        return false;
      }

      updated = await app.ordersRepository.findById(order!.id);
      return Boolean(updated?.is_relayable);
    });

    assert.strictEqual(updated?.is_relayable, true);
  });

  it("does not mark orders ready when signatures are below the threshold", async (t) => {
    let hitCount = 0;
    let payload = { data: [] as Array<unknown> };

    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        hitCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
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
    t.after(() => app.close());

    const order = await app.ordersRepository.create({
      id: 904,
      source: "qubic",
      dest: "solana",
      from: "HubG",
      to: "HubH",
      amount: 40,
      signature: "sig-hub-4",
      status: "ready-for-relay",
      is_relayable: false,
    });

    payload = { data: [{ orderId: order!.id, signatures: ["sig-5"] }] };

    await waitFor(() => hitCount > 0);

    const updated = await app.ordersRepository.findById(order!.id);
    assert.strictEqual(updated?.is_relayable, false);
  });

  it("logs when hub payload is invalid", async (t) => {
    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ orderId: "invalid", signatures: ["sig"] }],
          })
        );
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
    t.after(() => app.close());

    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await waitFor(() =>
      warnMock.calls.some(
        (call) => call.arguments[1] === "Invalid hub signatures payload"
      )
    );
  });

  it("logs when persisting signatures fails", async (t) => {
    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ orderId: 1, signatures: ["sig-1"] }],
          })
        );
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
    t.after(() => app.close());

    const { mock: errorMock } = t.mock.method(app.log, "error");
    const { mock: addMock } = t.mock.method(
      app.ordersRepository,
      "addSignatures"
    );
    addMock.mockImplementation(async () => {
      throw new Error("insert failed");
    });

    await waitFor(() =>
      errorMock.calls.some(
        (call) => call.arguments[1] === "Failed to persist hub signatures"
      )
    );
  });

  it("logs when hub poll fails", async (t) => {
    await startHubServer(t, HUB_PRIMARY_PORT, (req, res) => {
      if (req.url === "/api/orders/signatures") {
        res.writeHead(500);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await startHubServer(t, HUB_FALLBACK_PORT, (_req, res) => {
      res.writeHead(500);
      res.end();
    });

    const app = await build(t);
    t.after(() => app.close());

    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await waitFor(() =>
      warnMock.calls.some(
        (call) => call.arguments[1] === "Hub signatures poll failed"
      )
    );
  });
});
