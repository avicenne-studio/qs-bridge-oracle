import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import Fastify from "fastify";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { PublicKey, Connection } from "@solana/web3.js";
import { build, DEFAULT_TEST_CONFIG } from "../../helpers/build.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import {
  kRelayerService,
  type RelayerService,
  createRelayerService,
  startRelayer,
} from "../../../src/plugins/app/relayer/relayer.js";
import type { SolanaRelayDeps } from "../../../src/plugins/app/relayer/relay-solana.js";
import type { EnvConfig } from "../../../src/plugins/infra/env.js";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  QUBIC_TOKEN_ADDRESS,
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
  hexToBytes,
  bytesToHex,
  decodeSecretKey,
} from "../../../src/plugins/app/common/solana/index.js";
import { Network } from "../../../src/plugins/app/common/schemas/common.js";
import type { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";
import { getOracleSize } from "../../../src/clients/js/accounts/oracle.js";

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
      config: { QUBIC_RPC_URL: `${url}/rpc`, RELAYER_ENABLED: true, RELAYER_PROCESS_INTERVAL_MS: 5_000 },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(1), source: "solana", dest: "qubic", from: "A", to: "B",
      amount: "10", relayerFee: "0", origin_trx_hash: "trx-hash", signature: "sig",
      status: "ready-for-relay", oracle_accept_to_relay: true, relay_attempts: 0,
      source_nonce: "nonce-1", source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "relayed");
    assert.ok(updated?.destination_trx_hash);
  });

  it("marks orders failed after exceeding max relay attempts", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/unlock", async (_req, reply) => reply.code(500).send({ message: "boom" }));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (!addr || typeof addr === "string") throw new Error("Unable to determine server address");
    t.after(() => server.close());

    const app = await build(t, {
      useMocks: false,
      config: { QUBIC_RPC_URL: `http://127.0.0.1:${addr.port}`, RELAYER_ENABLED: true, RELAYER_PROCESS_INTERVAL_MS: 5_000, RELAYER_MAX_ATTEMPTS: 2 },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(2), source: "solana", dest: "qubic", from: "A", to: "B",
      amount: "10", relayerFee: "0", origin_trx_hash: "trx-hash", signature: "sig",
      status: "ready-for-relay", oracle_accept_to_relay: true, relay_attempts: 1,
      source_nonce: "nonce-2", source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "failed");
    assert.strictEqual(updated?.relay_attempts, 2);
    assert.strictEqual(updated?.failure_reason_public, "Relay failed");
  });

  it("keeps orders ready when relay attempts remain", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/unlock", async (_req, reply) => reply.code(500).send({ message: "boom" }));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (!addr || typeof addr === "string") throw new Error("Unable to determine server address");
    t.after(() => server.close());

    const app = await build(t, {
      useMocks: false,
      config: { QUBIC_RPC_URL: `http://127.0.0.1:${addr.port}`, RELAYER_ENABLED: true, RELAYER_PROCESS_INTERVAL_MS: 5_000, RELAYER_MAX_ATTEMPTS: 3 },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(5), source: "solana", dest: "qubic", from: "A", to: "B",
      amount: "10", relayerFee: "0", origin_trx_hash: "trx-hash", signature: "sig",
      status: "ready-for-relay", oracle_accept_to_relay: true, relay_attempts: 0,
      source_nonce: "nonce-5", source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "ready-for-relay");
    assert.strictEqual(updated?.relay_attempts, 1);
  });

  it("fails when the qubic unlock response is missing a transaction hash", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/unlock", async () => ({}));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (!addr || typeof addr === "string") throw new Error("Unable to determine server address");
    t.after(() => server.close());

    const app = await build(t, {
      useMocks: false,
      config: { QUBIC_RPC_URL: `http://127.0.0.1:${addr.port}`, RELAYER_ENABLED: true, RELAYER_PROCESS_INTERVAL_MS: 5_000, RELAYER_MAX_ATTEMPTS: 1 },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(4), source: "solana", dest: "qubic", from: "A", to: "B",
      amount: "10", relayerFee: "0", origin_trx_hash: "trx-hash", signature: "sig",
      status: "ready-for-relay", oracle_accept_to_relay: true, relay_attempts: 0,
      source_nonce: "nonce-4", source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "failed");
    assert.strictEqual(updated?.relay_attempts, 1);
  });

  it("records a failed relay attempt to solana when no signatures exist", async (t) => {
    const app = await build(t, {
      useMocks: false,
      config: { RELAYER_ENABLED: true, RELAYER_PROCESS_INTERVAL_MS: 5_000, RELAYER_MAX_ATTEMPTS: 3 },
    });
    const repo = app.getDecorator<OrdersRepository>(kOrdersRepository);
    const relayer = app.getDecorator<RelayerService>(kRelayerService);

    const order = await repo.create({
      id: makeId(3), source: "qubic", dest: "solana", from: "A", to: "B",
      amount: "10", relayerFee: "0", origin_trx_hash: "trx-hash", signature: "sig",
      status: "ready-for-relay", oracle_accept_to_relay: true, relay_attempts: 0,
      source_nonce: "nonce-3", source_payload: "{}",
    });

    await relayer.relayPending();

    const updated = await repo.findById(order!.id);
    assert.strictEqual(updated?.status, "ready-for-relay");
    assert.strictEqual(updated?.relay_attempts, 1);
  });

  it("relays a solana order successfully via createRelayerService", async () => {
    const oracleKp = generateKeyPairSync("ed25519");
    const oraclePub = oracleKp.publicKey.export({ type: "spki", format: "der" }).subarray(12);
    const fs = await import("node:fs");
    const relayerSigner = await createKeyPairSignerFromBytes(
      decodeSecretKey(JSON.parse(fs.readFileSync(DEFAULT_TEST_CONFIG.SOLANA_KEYS, "utf-8")).sKey)
    );

    const fromHex = bytesToHex(new Uint8Array(32).fill(1));
    const toHex = bytesToHex(new PublicKey(oraclePub).toBytes());
    const nonceHex = bytesToHex(new Uint8Array(32).fill(9));

    const digest = createHash("sha256").update(serializeBridgeOrder({
      protocolName: PROTOCOL_NAME, protocolVersion: PROTOCOL_VERSION,
      contractAddress: CONTRACT_ADDRESS_BYTES,
      networkIn: Network.Qubic, networkOut: Network.Solana,
      tokenIn: QUBIC_TOKEN_ADDRESS, tokenOut: new PublicKey(DEFAULT_TEST_CONFIG.TOKEN_MINT).toBytes(),
      fromAddress: hexToBytes(fromHex), toAddress: hexToBytes(toHex),
      amount: 1000n, relayerFee: 10n, nonce: hexToBytes(nonceHex),
    })).digest();
    const sigBase64 = Buffer.from(sign(null, digest, oracleKp.privateKey as import("node:crypto").KeyObject)).toString("base64");

    const solanaOrder: OracleOrder = {
      id: makeId(50), source: "qubic", dest: "solana", from: fromHex, to: toHex,
      amount: "1000", relayerFee: "10", origin_trx_hash: "trx-origin", signature: "sig",
      status: "ready-for-relay", oracle_accept_to_relay: true, relay_attempts: 0,
      source_nonce: nonceHex, source_payload: "{}",
    };

    let updatedWith: Record<string, unknown> | undefined;
    const oracleData = Buffer.alloc(getOracleSize());
    oracleData[0] = 2;
    oracleData.set(oraclePub, 1);

    const relayer = createRelayerService({
      ordersRepository: {
        findReadyForRelay: async () => [solanaOrder],
        update: async (_id: string, data: Record<string, unknown>) => { updatedWith = data; return { ...solanaOrder, ...data }; },
      } as unknown as OrdersRepository,
      config: DEFAULT_TEST_CONFIG,
      undiciClient: { create: () => ({}) } as unknown as Parameters<typeof createRelayerService>[0]["undiciClient"],
      logger: { info() {}, error() {} } as unknown as Parameters<typeof createRelayerService>[0]["logger"],
      solanaDeps: {
        config: DEFAULT_TEST_CONFIG, relayerSigner,
        connection: {
          getProgramAccounts: async () => [{ pubkey: new PublicKey(oraclePub), account: { data: oracleData } }],
        } as unknown as Connection,
        rpc: { getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999n } }) }) } as unknown as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => [sigBase64] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: { info() {}, error() {} } as unknown as SolanaRelayDeps["logger"],
        getLookupTable: async () => ({}),
      },
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "relayed");
    assert.ok(updatedWith.destination_trx_hash);
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
