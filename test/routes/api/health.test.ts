import { test } from "node:test";
import assert from "node:assert";
import { build } from "../../helper.js";
import { signHubHeaders } from "../../utils/hub-signing.js";
import {
  kKnex,
  type KnexAccessor,
} from "../../../src/plugins/infra/@knex.js";

test("GET /api/health success", async (t) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers: await signHubHeaders({ method: "GET", url: "/api/health" }),
  });

  assert.strictEqual(res.statusCode, 200);

  const body = JSON.parse(res.payload);

  assert.strictEqual(body.status, "ok");
  assert.ok(typeof body.timestamp === "string");
  assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
});

test("GET /api/health handles knex failure", async (t) => {
  const app = await build(t);
  const knex = app.getDecorator<KnexAccessor>(kKnex).get();

  const { mock: mockLog } = t.mock.method(app.log, "error");
  const { mock: mockSelect } = t.mock.method(knex, "select");
  mockSelect.mockImplementation(
    () =>
      ({
        first() {
          return Promise.resolve({ result: 0 }); // Triggers failure
        },
      } as never)
  );

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers: await signHubHeaders({ method: "GET", url: "/api/health" }),
  });

  assert.strictEqual(res.statusCode, 503);

  assert.deepStrictEqual(mockLog.calls[0].arguments, [
    "Database health check failed",
  ]);

  const body = JSON.parse(res.payload);
  assert.strictEqual(body.message, "Service Unavailable");
});
