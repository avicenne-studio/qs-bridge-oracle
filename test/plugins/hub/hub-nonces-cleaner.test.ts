import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import fp from "fastify-plugin";
import hubNoncesCleaner from "../../../src/plugins/app/hub/hub-nonces-cleaner.js";
import { kHubNoncesRepository } from "../../../src/plugins/app/hub/hub-nonces.repository.js";

describe("hub-nonces-cleaner", () => {
  it("runs cleanup without logging on success", async (t) => {
    const app = fastify();
    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await app.register(
      fp(
        async function fakeNoncesRepo(instance) {
          instance.decorate(kHubNoncesRepository, {
            exists: async () => false,
            insert: async () => {},
            deleteExpired: async () => 1,
          });
        },
        { name: "hub-nonces-repository" }
      )
    );
    await app.register(hubNoncesCleaner);
    await app.ready();
    await app.close();

    assert.strictEqual(warnMock.calls.length, 0);
  });

  it("logs when cleanup fails and clears interval on close", async (t) => {
    const app = fastify();
    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await app.register(
      fp(
        async function fakeNoncesRepo(instance) {
          instance.decorate(kHubNoncesRepository, {
            exists: async () => false,
            insert: async () => {},
            deleteExpired: async () => {
              throw new Error("boom");
            },
          });
        },
        { name: "hub-nonces-repository" }
      )
    );
    await app.register(hubNoncesCleaner);
    await app.ready();
    await app.close();

    const [logPayload, logMsg] = warnMock.calls[0]
      .arguments as [{ err: Error }, string];
    assert.strictEqual(logMsg, "Failed to cleanup hub nonces");
    assert.strictEqual(logPayload.err.message, "boom");
  });
});
