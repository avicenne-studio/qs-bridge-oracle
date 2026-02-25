import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../helpers/build.js";
import { waitFor } from "../../helpers/setup/wait-for.js";
import { mockLogMethod } from "../../helpers/mocks/logger.js";
import {
  kHubEventsRepository,
  type HubEventsRepository,
} from "../../../src/plugins/app/events/hub-events.repository.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import { kSolanaEventValidator } from "../../../src/plugins/app/events/solana/solana-events-validator.js";
import { kQubicEventValidator } from "../../../src/plugins/app/events/qubic/qubic-events-validator.js";
import { hex32 } from "../../../src/plugins/app/common/bytes.js";

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
    decorators: {
      [kSolanaEventValidator]: {
        validate: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        },
      },
    },
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
  errorMock = mockLogMethod(t, app.log, "error");

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
    decorators: {
      [kSolanaEventValidator]: {
        validate: async () => {
          throw new Error("Transaction failed");
        },
      },
    },
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
    decorators: {
      [kSolanaEventValidator]: {
        validate: async () => {
          throw new Error("Transaction failed");
        },
      },
    },
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

test("processor creates failed orders for qubic lock events", async (t) => {
  const intervalMs = 50;
  const maxRetries = 1;
  const lockNonce = hex32(77);

  const app = await build(t, {
    config: {
      EVENTS_PROCESS_INTERVAL_MS: intervalMs,
      EVENT_MAX_RETRIES: maxRetries,
    },
    decorators: {
      [kQubicEventValidator]: {
        validate: async () => {
          throw new Error("Transaction failed");
        },
      },
    },
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-qubic-failed",
    slot: null,
    chain: "qubic",
    type: "lock",
    nonce: lockNonce,
    payload: {
      fromAddress: hex32(78),
      toAddress: hex32(79),
      amount: "10",
      relayerFee: "12",
      nonce: lockNonce,
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const order = await ordersRepo.findBySourceNonce(lockNonce);
    return order?.status === "failed";
  }, 2_000);

  const order = await ordersRepo.findBySourceNonce(lockNonce);
  assert.ok(order);
  assert.strictEqual(order?.status, "failed");
  assert.strictEqual(order?.failure_reason_public, "Transaction failed");
});

test("processor skips failed lock orders when an order already exists", async (t) => {
  const intervalMs = 50;
  const maxRetries = 1;
  const lockNonce = hex32(88);

  const app = await build(t, {
    config: {
      EVENTS_PROCESS_INTERVAL_MS: intervalMs,
      EVENT_MAX_RETRIES: maxRetries,
    },
    decorators: {
      [kQubicEventValidator]: {
        validate: async () => {
          throw new Error("Transaction failed");
        },
      },
    },
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);
  const warnMock = mockLogMethod(t, app.log, "warn");

  await ordersRepo.create({
    id: "00000000-0000-4000-8000-000000000088",
    source: "qubic",
    dest: "solana",
    from: hex32(89),
    to: hex32(90),
    amount: "10",
    relayerFee: "1",
    origin_trx_hash: "trx-existing",
    signature: "sig-existing",
    status: "pending",
    oracle_accept_to_relay: true,
    relay_attempts: 0,
    source_nonce: lockNonce,
    source_payload: JSON.stringify({ v: 1 }),
  });

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-qubic-failed-existing",
    slot: null,
    chain: "qubic",
    type: "lock",
    nonce: lockNonce,
    payload: {
      fromAddress: hex32(89),
      toAddress: hex32(90),
      amount: "10",
      relayerFee: "12",
      nonce: lockNonce,
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(
    () =>
      warnMock.calls.some(
        (call) => call.arguments[1] === "Failed event order already exists"
      ),
    2_000
  );

  const order = await ordersRepo.findBySourceNonce(lockNonce);
  assert.ok(order);
  assert.strictEqual(order?.id, "00000000-0000-4000-8000-000000000088");
});

test("processor handles qubic lock events", async (t) => {
  const intervalMs = 50;
  const lockNonce = hex32(70);

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
    decorators: {
      [kQubicEventValidator]: {
        validate: async () => {},
      },
    },
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-qubic",
    slot: null,
    chain: "qubic",
    type: "lock",
    nonce: lockNonce,
    payload: {
      fromAddress: hex32(71),
      toAddress: hex32(72),
      amount: "10",
      relayerFee: "12",
      nonce: lockNonce,
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const order = await ordersRepo.findBySourceNonce(lockNonce);
    return Boolean(order);
  }, 2_000);

  const order = await ordersRepo.findBySourceNonce(lockNonce);
  assert.ok(order);
  assert.strictEqual(order?.source, "qubic");
  assert.strictEqual(order?.dest, "solana");
});

test("processor handles qubic override events", async (t) => {
  const intervalMs = 50;
  const overrideNonce = hex32(80);

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
    nonce: overrideNonce,
    payload: {
      fromAddress: hex32(81),
      toAddress: hex32(82),
      amount: "10",
      relayerFee: "9",
      nonce: overrideNonce,
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const stored = await repo.findBySignature("trx-qubic-override");
    return stored?.status === "done";
  }, 2_000);
});

test("processor stores destination transaction hash for qubic unlock events", async (t) => {
  const intervalMs = 50;
  const unlockNonce = hex32(90);

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
    decorators: {
      [kQubicEventValidator]: {
        validate: async () => {},
      },
    },
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);

  await ordersRepo.create({
    id: "00000000-0000-4000-8000-000000000999",
    source: "qubic",
    dest: "solana",
    from: hex32(91),
    to: hex32(92),
    amount: "10",
    relayerFee: "1",
    origin_trx_hash: "trx-lock",
    signature: "sig",
    status: "pending",
    oracle_accept_to_relay: true,
    relay_attempts: 0,
    source_nonce: unlockNonce,
    source_payload: JSON.stringify({ v: 1 }),
  });

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "trx-unlock",
    slot: null,
    chain: "qubic",
    type: "unlock",
    nonce: unlockNonce,
    payload: {
      toAddress: hex32(92),
      amount: "10",
      nonce: unlockNonce,
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const order = await ordersRepo.findBySourceNonce(unlockNonce);
    return order?.destination_trx_hash === "trx-unlock";
  }, 2_000);
});

test("processor finalizes order for solana inbound events", async (t) => {
  const intervalMs = 50;
  const inboundNonce = hex32(55);

  const app = await build(t, {
    config: { EVENTS_PROCESS_INTERVAL_MS: intervalMs },
    decorators: {
      [kSolanaEventValidator]: {
        validate: async () => {},
      },
    },
  });

  const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const ordersRepo = app.getDecorator<OrdersRepository>(kOrdersRepository);

  await ordersRepo.create({
    id: "00000000-0000-4000-8000-000000000055",
    source: "qubic",
    dest: "solana",
    from: "id(1,2,3)",
    to: "0xabc",
    amount: "10",
    relayerFee: "1",
    origin_trx_hash: "trx-lock",
    signature: "sig",
    status: "pending",
    oracle_accept_to_relay: true,
    relay_attempts: 0,
    source_nonce: inboundNonce,
    source_payload: JSON.stringify({ v: 1 }),
  });

  await repo.upsert({
    hubUrl: "http://hub-1",
    signature: "mint-tx-solana",
    slot: 100,
    chain: "solana",
    type: "inbound",
    nonce: inboundNonce,
    payload: {
      networkIn: 1,
      networkOut: 2,
      tokenIn: hex32(1),
      tokenOut: hex32(2),
      fromAddress: hex32(3),
      toAddress: hex32(4),
      amount: "10",
      relayerFee: "2",
      nonce: inboundNonce,
    },
    createdAt: "2024-01-01 00:00:00",
  });

  await waitFor(async () => {
    const order = await ordersRepo.findBySourceNonce(inboundNonce);
    return order?.destination_trx_hash === "mint-tx-solana" && order?.status === "finalized";
  }, 2_000);

  const order = await ordersRepo.findBySourceNonce(inboundNonce);
  assert.ok(order);
  assert.strictEqual(order?.destination_trx_hash, "mint-tx-solana");
  assert.strictEqual(order?.status, "finalized");
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
