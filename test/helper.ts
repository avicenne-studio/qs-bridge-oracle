import fastify, { FastifyInstance, LightMyRequestResponse } from "fastify";
import { TestContext } from "node:test";
import serviceApp from "../src/app.js";
import assert from "node:assert";
import fp from "fastify-plugin";
import path from "node:path";

const hubKeysPublicFixturePath = path.join(
  process.cwd(),
  "test/fixtures/hub-keys.json"
);

// Fill in this config with all the configurations
// needed for testing the application
export function config() {
  return {
    skipOverride: true, // Register our application with fastify-plugin
  };
}

export function expectValidationError(
  res: LightMyRequestResponse,
  expectedMessage: string
) {
  assert.strictEqual(res.statusCode, 400);
  const { message } = JSON.parse(res.payload);
  assert.strictEqual(message, expectedMessage);
}

// automatically build and tear down our instance
export async function build(
  t?: TestContext,
  beforeReady?: (fastify: FastifyInstance) => void | Promise<void>
) {
  process.env.HUB_KEYS_FILE =
    process.env.HUB_KEYS_FILE ?? hubKeysPublicFixturePath;
  // you can set all the options supported by the fastify CLI command
  const app = fastify();
  app.register(fp(serviceApp));

  if (beforeReady) {
    await beforeReady(app);
  }

  await app.ready();

  // This is after start, so we can't decorate the instance using `.decorate`

  // If we pass the test contest, it will close the app after we are done
  if (t) {
    t.after(() => app.close());
  }

  return app;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 100
) {
  const start = Date.now();
  while (true) {
    if (await condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
