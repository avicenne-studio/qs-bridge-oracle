import fastify, { FastifyInstance, LightMyRequestResponse } from "fastify";
import { TestContext } from "node:test";
import serviceApp from "../src/app.js";
import assert from "node:assert";
import fp from "fastify-plugin";

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

class NoopWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = NoopWebSocket.OPEN;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void) {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(handler);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    bucket.delete(handler);
  }

  send() {}

  close() {
    this.readyState = NoopWebSocket.CLOSED;
    const bucket = this.listeners.get("close");
    if (!bucket) {
      return;
    }
    for (const handler of bucket) {
      handler({});
    }
  }
}

// automatically build and tear down our instance
type BuildHooks = {
  beforeRegister?: (fastify: FastifyInstance) => void | Promise<void>;
  beforeReady?: (fastify: FastifyInstance) => void | Promise<void>;
};

export async function build(
  t?: TestContext,
  hooks?: ((fastify: FastifyInstance) => void | Promise<void>) | BuildHooks
) {
  // you can set all the options supported by the fastify CLI command
  const app = fastify();
  const resolvedHooks: BuildHooks =
    typeof hooks === "function" ? { beforeReady: hooks } : hooks ?? {};

  if (resolvedHooks.beforeRegister) {
    await resolvedHooks.beforeRegister(app);
  }

  if (!app.hasDecorator("solanaWsFactory")) {
    app.decorate("solanaWsFactory", () => new NoopWebSocket());
  }

  app.register(fp(serviceApp));

  if (resolvedHooks.beforeReady) {
    await resolvedHooks.beforeReady(app);
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
