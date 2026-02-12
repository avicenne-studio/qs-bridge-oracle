import fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { TestContext } from "node:test";
import serviceApp from "../../src/app.js";
import assert from "node:assert";
import fp from "fastify-plugin";
import type { EnvConfig } from "../../src/plugins/infra/env.js";
import { kEnvConfig } from "../../src/plugins/infra/env.js";
import { kPoller } from "../../src/plugins/infra/poller.js";
import { kUndiciGetClient } from "../../src/plugins/infra/undici-get-client.js";
import { createMockPollerService } from "./infra/poller-mock.js";
import { createMockUndiciGetClientService } from "./infra/undici-get-client-mock.js";

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
type BuildHooks = {
  beforeRegister?: (fastify: FastifyInstance) => void | Promise<void>;
  beforeReady?: (fastify: FastifyInstance) => void | Promise<void>;
};

type BuildOptions = BuildHooks & {
  useMocks?: boolean;
  config?: Partial<EnvConfig>;
  decorators?: Record<PropertyKey, unknown>;
  logger?: boolean;
};

export const DEFAULT_TEST_CONFIG: EnvConfig = {
  HOST: "127.0.0.1",
  PORT: 3000,
  RATE_LIMIT_MAX: 4,
  POLLER_INTERVAL_MS: 50,
  POLLER_REQUEST_TIMEOUT_MS: 200,
  POLLER_JITTER_MS: 0,
  SQLITE_DB_FILE: ":memory:",
  SOLANA_KEYS: "./test/fixtures/signer/solana.keys.json",
  QUBIC_KEYS: "./test/fixtures/signer/qubic.keys.json",
  ORACLE_SIGNATURE_THRESHOLD: 2,
  HUB_URLS: "http://localhost:3001",
  HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
  SOLANA_RPC_URL: "http://localhost:8899",
  SOLANA_TX_COMMITMENT: "confirmed",
  SOLANA_BPS_FEE: 0,
  RELAYER_FEE_SOLANA: "1000",
  RELAYER_FEE_QUBIC: "500",
  EVENT_MAX_RETRIES: 3,
  EVENTS_LOOKBACK_DAYS: 14,
  EVENTS_PROCESS_INTERVAL_MS: 50,
};

function resolveBuildOptions(
  hooks?: ((fastify: FastifyInstance) => void | Promise<void>) | BuildHooks | BuildOptions
): BuildOptions {
  if (typeof hooks === "function") {
    return { beforeReady: hooks };
  }
  return (hooks ?? {}) as BuildOptions;
}

function applyDecorators(
  app: FastifyInstance,
  decorators: Record<PropertyKey, unknown>
) {
  for (const [key, value] of Object.entries(decorators)) {
    if (app.hasDecorator(key)) {
      continue;
    }
    app.decorate(key, value);
  }
  for (const symbol of Object.getOwnPropertySymbols(decorators)) {
    if (app.hasDecorator(symbol)) {
      continue;
    }
    app.decorate(symbol, Reflect.get(decorators, symbol));
  }
}

export async function build(
  t?: TestContext,
  hooks?: ((fastify: FastifyInstance) => void | Promise<void>) | BuildHooks | BuildOptions
) {
  // you can set all the options supported by the fastify CLI command
  const resolvedHooks = resolveBuildOptions(hooks);
  const app = fastify({ logger: resolvedHooks.logger ?? false });

  if (!app.hasDecorator(kEnvConfig)) {
    const testConfig = {
      ...DEFAULT_TEST_CONFIG,
      ...(resolvedHooks.config ?? {}),
    };
    app.decorate(kEnvConfig, testConfig);
  }

  if (resolvedHooks.useMocks ?? true) {
    if (!app.hasDecorator(kPoller)) {
      app.decorate(kPoller, createMockPollerService());
    }
    if (!app.hasDecorator(kUndiciGetClient)) {
      app.decorate(kUndiciGetClient, createMockUndiciGetClientService());
    }
  }

  if (resolvedHooks.decorators) {
    applyDecorators(app, resolvedHooks.decorators);
  }

  if (resolvedHooks.beforeRegister) {
    await resolvedHooks.beforeRegister(app);
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
  timeoutMs = 2_000,
  intervalMs = 50
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
