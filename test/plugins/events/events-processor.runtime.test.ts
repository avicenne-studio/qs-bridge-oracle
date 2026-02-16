import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { build, waitFor } from "../../helpers/build.js";
import {
  kHubEventsRepository,
  type HubEventsRepository,
} from "../../../src/plugins/app/events/hub-events.repository.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import {
  kSolanaEventValidator,
  type SolanaEventValidator,
} from "../../../src/plugins/app/events/solana/solana-events-validator.js";
import {
  kQubicEventValidator,
  type QubicEventValidator,
} from "../../../src/plugins/app/events/qubic/qubic-events-validator.js";

const hex32 = (value: number) =>
  Buffer.from(new Uint8Array(32).fill(value)).toString("hex");

function createOutboundPayload(seed: number) {
  return {
    networkIn: 1,
    networkOut: 1,
    tokenIn: hex32(seed),
    tokenOut: hex32(seed + 1),
    fromAddress: hex32(seed + 2),
    toAddress: hex32(seed + 3),
    amount: "10",
    relayerFee: "2",
    nonce: hex32(seed + 4),
  };
}

test("processor skips overlapping runs", async (t) => {
  const intervalMs = 50;

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
  });
  const validator =
    app.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
  t.mock.method(validator, "validate", async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "sig-overlap",
    slot: 1,
    chain: "solana",
    type: "outbound",
    nonce: hex32(1),
    payload: createOutboundPayload(10),
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const pending = await repo.listPending(10);
    return pending.length === 0;
  }, 2_000);
});

test("processor logs when processing throws", async (t) => {
  const intervalMs = 50;

  let errorMock: { calls: Array<{ arguments: unknown[] }> } | null = null;
  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
  });
  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  t.mock.method(repo, "listPending", async () => {
    throw new Error("boom");
  });
  errorMock = t.mock.method(app.log, "error").mock;

  await waitFor(
    () =>
      Boolean(
        errorMock?.calls.some(
          (call) => call.arguments[1] === "Failed to process pending hub events"
        )
      ),
    2_000
  );
  assert.ok(errorMock);
});

test("processor skips failed order creation when payload mapping mismatches", async (t) => {
  const intervalMs = 50;
  const maxRetries = 1;

  const app = await build(t, {
    config: {
      EVENTS_PROCESS_INTERVAL_MS: intervalMs,
      EVENT_MAX_RETRIES: maxRetries,
    },
  });
  const validator =
    app.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
  t.mock.method(validator, "validate", async () => {
    throw new Error("Transaction failed");
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "sig-mismatch",
    slot: 1,
    chain: "solana",
    type: "outbound",
    nonce: hex32(2),
    payload: {
      toAddress: hex32(3),
      relayerFee: "1",
      nonce: hex32(2),
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const stored = await repo.findBySignature("sig-mismatch");
    return stored?.status === "failed";
  }, 2_000);
});

test("processor creates failed orders for outbound events", async (t) => {
  const intervalMs = 50;
  const maxRetries = 1;

  const app = await build(t, {
    config: {
      EVENTS_PROCESS_INTERVAL_MS: intervalMs,
      EVENT_MAX_RETRIES: maxRetries,
    },
  });
  const validator =
    app.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
  t.mock.method(validator, "validate", async () => {
    throw new Error("Transaction failed");
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);
  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "sig-failed-order",
    slot: 1,
    chain: "solana",
    type: "outbound",
    nonce: hex32(3),
    payload: createOutboundPayload(30),
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const order = await ordersRepo.findBySourceNonce(hex32(34));
    return order?.status === "failed";
  }, 2_000);

  const order = await ordersRepo.findBySourceNonce(hex32(34));
  assert.ok(order);
  assert.strictEqual(order?.status, "failed");
});

test("processor handles qubic lock events", async (t) => {
  const intervalMs = 50;

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
  });
  const qubicValidator =
    app.getDecorator<QubicEventValidator>(kQubicEventValidator);
  t.mock.method(qubicValidator, "validate", async () => {});

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-qubic",
    slot: null,
    chain: "qubic",
    type: "lock",
    nonce: "123",
    payload: {
      fromAddress: "id(1,2,3,4)",
      toAddress: "0xabc",
      amount: "10",
      relayerFee: "12",
      nonce: "123",
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const order = await ordersRepo.findBySourceNonce("123");
    return Boolean(order);
  }, 2_000);

  const order = await ordersRepo.findBySourceNonce("123");
  assert.ok(order);
  assert.strictEqual(order?.source, "qubic");
  assert.strictEqual(order?.dest, "solana");
});

test("processor handles qubic override events", async (t) => {
  const intervalMs = 50;

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
    decorators: {
      [kQubicEventValidator]: {
        validate: async () => {},
      }
    },
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-qubic-override",
    slot: null,
    chain: "qubic",
    type: "override-lock",
    nonce: "777",
    payload: {
      fromAddress: "id(1,2,3,4)",
      toAddress: "0xdef",
      amount: "10",
      relayerFee: "9",
      nonce: "777",
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const stored = await repo.findBySignature("trx-qubic-override");
    return stored?.status === "done";
  }, 2_000);
});

test("processor skips unsupported chain events", async (t) => {
  const intervalMs = 50;

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
  });
  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-unknown",
    slot: null,
    chain: "unknown",
    type: "mystery",
    nonce: "999",
    payload: {},
    createdAt: "2024-01-01 00:00:00",
  } as never);

  await waitFor(async () => {
    const stored = await repo.findBySignature("trx-unknown");
    return stored?.status === "done";
  }, 2_000);
});
