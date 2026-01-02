import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build, waitFor } from "../helper.js";
import { ORDER_SIGNATURES_TABLE_NAME } from "../../src/plugins/app/indexer/orders.repository.js";

describe("hub signatures polling", () => {
  it("starts polling on app startup", async (t) => {
    let hitCount = 0;

    const server = createServer((req, res) => {
      if (req.url === "/api/orders/signatures") {
        hitCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(6101, resolve));
    t.after(() => server.close());

    const app = await build(t);
    t.after(() => app.close());

    await waitFor(() => hitCount > 0);
    assert.ok(hitCount > 0);
  });

  it("stores signatures from hub responses", async (t) => {
    const originalHubUrls = process.env.HUB_URLS;
    let hitCount = 0;
    let payload = { data: [] as Array<unknown> };

    const server = createServer((req, res) => {
      if (req.url === "/api/orders/signatures") {
        hitCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(6102, resolve));
    t.after(() => server.close());
    process.env.HUB_URLS = "http://127.0.0.1:6102";
    t.after(() => {
      process.env.HUB_URLS = originalHubUrls;
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

  it("logs when hub payload is invalid", async (t) => {
    const originalHubUrls = process.env.HUB_URLS;

    const server = createServer((req, res) => {
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

    await new Promise<void>((resolve) => server.listen(6104, resolve));
    t.after(() => server.close());
    process.env.HUB_URLS = "http://127.0.0.1:6104";
    t.after(() => {
      process.env.HUB_URLS = originalHubUrls;
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
    const originalHubUrls = process.env.HUB_URLS;

    const server = createServer((req, res) => {
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

    await new Promise<void>((resolve) => server.listen(6105, resolve));
    t.after(() => server.close());
    process.env.HUB_URLS = "http://127.0.0.1:6105";
    t.after(() => {
      process.env.HUB_URLS = originalHubUrls;
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
    const originalHubUrls = process.env.HUB_URLS;

    const server = createServer((req, res) => {
      if (req.url === "/api/orders/signatures") {
        res.writeHead(500);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(6103, resolve));
    t.after(() => server.close());
    process.env.HUB_URLS = "http://127.0.0.1:6103";
    t.after(() => {
      process.env.HUB_URLS = originalHubUrls;
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
