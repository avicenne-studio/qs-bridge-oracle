import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import fp from "fastify-plugin";
import {
  kPoller,
  RECOMMENDED_POLLING_DEFAULTS,
  type CreatePollerConfig,
  type PollerService,
} from "../../../src/plugins/infra/poller.js";
import {
  kUndiciGetClient,
  type UndiciGetClientService,
} from "../../../src/plugins/infra/undici-get-client.js";
import validationPlugin from "../../../src/plugins/app/common/validation.js";
import {
  kOrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import {
  kSignerService,
} from "../../../src/plugins/app/signer/signer.service.js";
import {
  kSolanaEventValidator,
  type SolanaEventValidator,
} from "../../../src/plugins/app/events/solana/solana-events-validator.js";
import { kEnvConfig } from "../../../src/plugins/infra/env.js";
import eventsService, {
  buildHubEventsPath,
} from "../../../src/plugins/app/events/events.service.js";
import { createInMemoryOrders } from "../../utils/in-memory-orders.js";

const hex32 = (value: number) => value.toString(16).padStart(64, "0");

function createOutboundEventResponse() {
  return {
    data: [
      {
        id: 1,
        signature: "sig-evt",
        slot: 10,
        chain: "solana",
        type: "outbound",
        nonce: hex32(1),
        payload: {
          networkIn: 1,
          networkOut: 1,
          tokenIn: hex32(2),
          tokenOut: hex32(3),
          fromAddress: hex32(4),
          toAddress: hex32(5),
          amount: "10",
          relayerFee: "2",
          nonce: hex32(1),
        },
        createdAt: new Date().toISOString(),
      },
    ],
    cursor: 1,
  };
}

async function buildEventsApp({
  response,
  validator,
  initialOrders = [],
}: {
  response: unknown;
  validator: SolanaEventValidator;
  initialOrders?: Parameters<typeof createInMemoryOrders>[0];
}) {
  const app = fastify({ logger: false });
  let captured: CreatePollerConfig<unknown> | null = null;

  const pollerService: PollerService = {
    defaults: RECOMMENDED_POLLING_DEFAULTS,
    create<TResponse>(config: CreatePollerConfig<TResponse>) {
      captured = config as unknown as CreatePollerConfig<unknown>;
      return {
        start() {},
        stop: async () => {},
        isRunning: () => true,
      };
    },
  };

  const undiciService: UndiciGetClientService = {
    create: () => ({
      getJson: async () => response,
    }),
  };

  app.register(
    fp(async (instance) => {
      instance.decorate(kEnvConfig, {
        HOST: "127.0.0.1",
        PORT: 3000,
        RATE_LIMIT_MAX: 100,
        SQLITE_DB_FILE: ":memory:",
        SOLANA_KEYS: "./test/fixtures/signer/solana.keys.json",
        QUBIC_KEYS: "./test/fixtures/signer/qubic.keys.json",
        ORACLE_SIGNATURE_THRESHOLD: 2,
        HUB_URLS: "http://hub-primary,http://hub-fallback",
        HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
        SOLANA_RPC_URL: "http://localhost:8899",
        SOLANA_BPS_FEE: 25,
        RELAYER_FEE_PERCENT: "0.1",
      });
    }, { name: "env" })
  );
  app.register(validationPlugin);
  app.register(
    fp(async (instance) => {
      const repo = createInMemoryOrders(initialOrders);
      instance.decorate(kOrdersRepository, repo);
    }, { name: "orders-repository" })
  );
  app.register(
    fp(async (instance) => {
      instance.decorate(kSignerService, {
        signSolanaOrder: async () => "signed",
      });
    }, { name: "signer-service" })
  );
  app.register(
    fp(async (instance) => {
      instance.decorate(kSolanaEventValidator, validator);
    }, { name: "solana-events-validator" })
  );
  app.register(
    fp(async (instance) => {
      instance.decorate(kUndiciGetClient, undiciService);
    }, { name: "undici-get-client" })
  );
  app.register(
    fp(async (instance) => {
      instance.decorate(kPoller, pollerService);
    }, { name: "polling" })
  );
  app.register(eventsService);
  await app.ready();

  return { app, captured };
}

describe("hub events service", () => {
  it("builds hub events paths", () => {
    assert.strictEqual(
      buildHubEventsPath(5, 10),
      "/api/orders/events?after=5&limit=10"
    );
  });

  it("processes valid events and creates orders", async () => {
    const validator: SolanaEventValidator = {
      validate: async () => {},
    };
    const response = createOutboundEventResponse();
    const { app, captured } = await buildEventsApp({ response, validator });

    assert.ok(captured);
    await captured!.onRound(response, {
      round: 1,
      startedAt: Date.now(),
      primary: "http://hub-primary",
      fallback: "http://hub-fallback",
      used: "http://hub-primary",
    });

    const repo = app.getDecorator(kOrdersRepository);
    const stored = await repo.findBySourceNonce(hex32(1));
    assert.ok(stored);
    assert.strictEqual(stored?.signature, "signed");

    await app.close();
  });

  it("logs when payload is invalid", async (t) => {
    const validator: SolanaEventValidator = {
      validate: async () => {},
    };
    const { app, captured } = await buildEventsApp({
      response: { bad: "payload" },
      validator,
    });
    const { mock: warnMock } = t.mock.method(app.log, "warn");

    await captured!.onRound({ bad: "payload" }, {
      round: 1,
      startedAt: Date.now(),
      primary: "http://hub-primary",
      fallback: "http://hub-fallback",
      used: "http://hub-primary",
    });

    assert.ok(
      warnMock.calls.some(
        (call) => call.arguments[1] === "Invalid hub events payload"
      )
    );
    await app.close();
  });

  it("logs when processing fails", async (t) => {
    const validator: SolanaEventValidator = {
      validate: async () => {
        throw new Error("boom");
      },
    };
    const response = createOutboundEventResponse();
    const { app, captured } = await buildEventsApp({ response, validator });
    const { mock: logMock } = t.mock.method(app.log, "error");

    await captured!.onRound(response, {
      round: 1,
      startedAt: Date.now(),
      primary: "http://hub-primary",
      fallback: "http://hub-fallback",
      used: "http://hub-primary",
    });

    assert.ok(
      logMock.calls.some(
        (call) => call.arguments[1] === "Failed to process hub event"
      )
    );
    await app.close();
  });

  it("processes override events", async () => {
    const validator: SolanaEventValidator = {
      validate: async () => {},
    };
    const overrideResponse = {
      data: [
        {
          id: 2,
          signature: "sig-override",
          slot: 11,
          chain: "solana",
          type: "override-outbound",
          nonce: hex32(9),
          payload: {
            toAddress: hex32(8),
            relayerFee: "7",
            nonce: hex32(9),
          },
          createdAt: new Date().toISOString(),
        },
      ],
      cursor: 2,
    };
    const existingOrder = {
      id: "00000000-0000-4000-8000-000000000009",
      source: "solana",
      dest: "qubic",
      from: hex32(1),
      to: hex32(2),
      amount: "10",
      relayerFee: "1",
      signature: "sig",
      status: "pending",
      oracle_accept_to_relay: true,
      source_nonce: hex32(9),
      source_payload: JSON.stringify({
        v: 1,
        networkIn: 1,
        networkOut: 1,
        tokenIn: hex32(3),
        tokenOut: hex32(4),
        nonce: hex32(9),
      }),
    };

    const { app, captured } = await buildEventsApp({
      response: overrideResponse,
      validator,
      initialOrders: [existingOrder],
    });

    await captured!.onRound(overrideResponse, {
      round: 1,
      startedAt: Date.now(),
      primary: "http://hub-primary",
      fallback: "http://hub-fallback",
      used: "http://hub-primary",
    });

    const repo = app.getDecorator(kOrdersRepository);
    const stored = await repo.findBySourceNonce(hex32(9));
    assert.ok(stored);
    assert.strictEqual(stored?.relayerFee, "7");

    await app.close();
  });

  it("falls back to the primary hub when none is used", async () => {
    const validator: SolanaEventValidator = {
      validate: async () => {},
    };
    const response = createOutboundEventResponse();
    const { app, captured } = await buildEventsApp({ response, validator });

    await captured!.onRound(response, {
      round: 1,
      startedAt: Date.now(),
      primary: "http://hub-primary",
      fallback: "http://hub-fallback",
      used: undefined,
    });

    const repo = app.getDecorator(kOrdersRepository);
    const stored = await repo.findBySourceNonce(hex32(1));
    assert.ok(stored);

    await app.close();
  });
});
