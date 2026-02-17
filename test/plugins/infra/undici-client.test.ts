import { describe, it, TestContext } from "node:test";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { build } from "../../helpers/build.js";
import {
  kUndiciClient,
  type UndiciClientService,
} from "../../../src/plugins/infra/undici-client.js";

describe("undici client plugin", () => {
  it("performs GET and POST requests with merged headers and JSON parsing", async (t: TestContext) => {
    const app = await build(t, { useMocks: false });
    const undiciClient: UndiciClientService =
      app.getDecorator(kUndiciClient);

    const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
    const server = createServer((req, res) => {
      receivedHeaders.push(req.headers);
      if (req.url === "/poll" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/submit" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ trxHash: "trx-1" }));
        return;
      }

      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, resolve);
    });
    t.after(() => server.close());

    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    const client = undiciClient.create({
      headers: { "x-default": "base" },
    });

    const data = await client.getJson<{ ok: boolean }>(
      origin,
      "/poll",
      undefined,
      { "x-extra": "1", "x-default": "override" }
    );

    t.assert.deepStrictEqual(data, { ok: true });
    t.assert.strictEqual(receivedHeaders[0]["x-extra"], "1");
    t.assert.strictEqual(receivedHeaders[0]["x-default"], "override");

    const posted = await client.postJson<{ trxHash: string }>(
      origin,
      "/submit",
      { ok: true },
      undefined,
      { "x-default": "override-post" }
    );

    t.assert.deepStrictEqual(posted, { trxHash: "trx-1" });
    t.assert.strictEqual(receivedHeaders[1]["x-default"], "override-post");

    await t.assert.rejects(client.getJson(origin, "/fail"), /HTTP 503/);

    await client.close();
  });

  it("closes created clients on app shutdown and exposes defaults", async (t: TestContext) => {
    const app = await build(undefined, { useMocks: false });
    const undiciClient: UndiciClientService =
      app.getDecorator(kUndiciClient);

    t.assert.deepStrictEqual(undiciClient.defaults, {
      connectionsPerOrigin: 1,
      pipelining: 1,
      headers: {},
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
      connectTimeout: 5_000,
    });

    const client = undiciClient.create();
    let closed = false;
    const originalClose = client.close.bind(client);
    client.close = async () => {
      closed = true;
      await originalClose();
    };

    await app.close();
    t.assert.ok(closed, "client.close should be invoked on shutdown");
  });
});
