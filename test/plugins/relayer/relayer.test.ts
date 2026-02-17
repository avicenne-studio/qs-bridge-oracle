import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { build } from "../../helpers/build.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import {
  kRelayerService,
  type RelayerService,
  startRelayer,
} from "../../../src/plugins/app/relayer/relayer.js";
import type { EnvConfig } from "../../../src/plugins/infra/env.js";

function makeId(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

async function startQubicServer(t: TestContext, basePath = "") {
  const server = Fastify({ logger: false });
  let callCount = 0;
  const normalized = basePath && !basePath.startsWith("/") ? `/${basePath}` : basePath;

  server.post(`${normalized}/unlock`, async () => {
    callCount += 1;
    return { trxHash: `trx-unlock-${callCount}` };
  });

  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server address");
  }
  const url = `http://127.0.0.1:${address.port}`;

  t.after(() => server.close());
  return { url };
}

describe("relayer plugin", () => {
  it("relays ready orders to qubic and stores destination trx hash", async (t) => {
    const { url } = await startQubicServer(t, "/rpc");
    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_RPC_URL: `${url}/rpc`,
        RELAYER_PROCESS_INTERVAL_MS: 5_000,
      },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(1),
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      max_relay_attempts: 2,
      source_nonce: "nonce-1",
      source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "relayed");
    assert.ok(updated?.destination_trx_hash);
  });

  it("marks orders failed after exceeding max relay attempts", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/unlock", async (_request, reply) => {
      return reply.code(500).send({ message: "boom" });
    });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine server address");
    }
    const url = `http://127.0.0.1:${address.port}`;
    t.after(() => server.close());

    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_RPC_URL: url,
        RELAYER_PROCESS_INTERVAL_MS: 5_000,
      },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(2),
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      max_relay_attempts: 2,
      source_nonce: "nonce-2",
      source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "failed");
    assert.strictEqual(updated?.relay_attempts, 2);
    assert.strictEqual(updated?.failure_reason_public, "Relay failed");
  });

  it("fails when the qubic unlock response is missing a transaction hash", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/unlock", async () => ({}));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine server address");
    }
    const url = `http://127.0.0.1:${address.port}`;
    t.after(() => server.close());

    const app = await build(t, {
      useMocks: false,
      config: {
        QUBIC_RPC_URL: url,
        RELAYER_PROCESS_INTERVAL_MS: 5_000,
      },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(4),
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      max_relay_attempts: 1,
      source_nonce: "nonce-4",
      source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "failed");
    assert.strictEqual(updated?.relay_attempts, 1);
  });

  it("relays to solana with a placeholder transaction hash", async (t) => {
    const app = await build(t, {
      useMocks: false,
      config: {
        RELAYER_PROCESS_INTERVAL_MS: 5_000,
      },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(3),
      source: "qubic",
      dest: "solana",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      max_relay_attempts: 2,
      source_nonce: "nonce-3",
      source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "relayed");
    assert.ok(updated?.destination_trx_hash);
  });

  it("short-circuits when the relayer decorator already exists", async (t) => {
    const app = await build(t, {
      decorators: {
        [kRelayerService]: { relayPending: async () => {} },
      },
    });
    assert.ok(app.hasDecorator(kRelayerService));
  });

  it("prevents overlapping relayer cycles and logs failures", async (t) => {
    const app = Fastify({ logger: false });
    let calls = 0;
    const relayer = {
      async relayPending() {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
        } else {
          throw new Error("boom");
        }
      },
    };
    const { mock: logMock } = t.mock.method(app.log, "error");

    startRelayer(app, {
      relayer,
      config: { RELAYER_PROCESS_INTERVAL_MS: 20 } as EnvConfig,
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    await app.close();

    assert.ok(calls >= 1);
    assert.ok(logMock.calls.length >= 1);
  });
});
