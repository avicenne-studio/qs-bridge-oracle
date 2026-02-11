import { test } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import fp from "fastify-plugin";
import hubNoncesRepositoryPlugin, {
  kHubNoncesRepository,
} from "../../../src/plugins/app/hub/hub-nonces.repository.js";

test("hub nonces repository keeps existing decorator", async (t) => {
  const app = fastify({ logger: false });
  const existing = {
    exists: async () => false,
    insert: async () => {},
    deleteExpired: async () => 0,
  };

  app.decorate(kHubNoncesRepository, existing);
  app.register(fp(async () => {}, { name: "knex" }));
  await app.register(hubNoncesRepositoryPlugin);
  await app.ready();
  t.after(() => app.close());

  const repo = app.getDecorator(kHubNoncesRepository);
  assert.strictEqual(repo, existing);
});
