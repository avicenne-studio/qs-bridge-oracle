import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build, waitFor } from "../helper.js";

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
});
