import { it } from "node:test";
import assert from "node:assert";
import fastify from "fastify";
import fp from "fastify-plugin";
import path from "node:path";
import serviceApp from "../../src/app.js";

it('should call errorHandler', async (t) => {
  const app = fastify();
  const originalEnv = { ...process.env };
  process.env.SQLITE_DB_FILE =
    process.env.SQLITE_DB_FILE ??
    path.join(process.cwd(), "test/fixtures/error-handler.sqlite3");
  process.env.PORT = process.env.PORT ?? "0";
  process.env.SOLANA_KEYS =
    process.env.SOLANA_KEYS ??
    path.join(process.cwd(), "test/fixtures/signer/solana.keys.json");
  process.env.QUBIC_KEYS =
    process.env.QUBIC_KEYS ??
    path.join(process.cwd(), "test/fixtures/signer/qubic.keys.json");
  process.env.HUB_URLS =
    process.env.HUB_URLS ?? "http://127.0.0.1:3010,http://127.0.0.1:3011";
  process.env.HUB_KEYS_FILE =
    process.env.HUB_KEYS_FILE ??
    path.join(process.cwd(), "test/fixtures/hub-keys.json");

  await app.register(fp(serviceApp));

  app.get('/error', () => {
    throw new Error('Kaboom!')
  })

  await app.ready();

  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/error",
  });

  assert.deepStrictEqual(JSON.parse(res.payload), {
    message: "Internal Server Error",
  });
})
