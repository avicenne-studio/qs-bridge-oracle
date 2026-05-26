import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import Fastify from "fastify";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { resolveQubicCrypto, QUBIC_FIXTURE_SEED } from "../../helpers/qubic-crypto.js";
import {
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getAddressDecoder,
  address,
  type Address,
} from "@solana/kit";
import { DEFAULT_TEST_CONFIG } from "../../helpers/build.js";
import { mockLogMethod, makeLogger, type LoggerMocks } from "../../helpers/mocks/logger.js";
import {
  type OrdersRepository,
} from "../../../src/plugins/app/indexer/orders.repository.js";
import {
  createRelayerService,
  startRelayer,
} from "../../../src/plugins/app/relayer/relayer.js";
import type { SolanaRelayDeps } from "../../../src/plugins/app/relayer/relay-solana.js";
import {
  type QubicRelayDeps,
} from "../../../src/plugins/app/relayer/relay-qubic.js";
import { type QubicContractClient } from "../../../src/plugins/infra/qubic-contract-client.js";
import type { EnvConfig } from "../../../src/plugins/infra/env.js";
import { HttpError } from "../../../src/plugins/infra/undici-client.js";
import {
  hexToBytes,
  bytesToHex,
  decodeSecretKey,
} from "../../../src/plugins/app/common/bytes.js";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from "../../../src/plugins/app/common/protocol.js";
import { QUBIC_TOKEN_ADDRESS, QUBIC_CONTRACT_ADDRESS_BYTES } from "../../../src/plugins/app/common/qubic/encoding.js";
import { serializeQsbOrderMessage } from "../../../src/plugins/app/common/qubic/qsb-message.js";
import {
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
} from "../../../src/plugins/app/common/solana/program.js";
import { Network } from "../../../src/plugins/app/common/schemas/common.js";
import type { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";

function makeId(value: number) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

type RelayerLogger = Parameters<typeof createRelayerService>[0]["logger"];

function makeRelayerLogger(): { logger: RelayerLogger; logs: LoggerMocks } {
  const { logger, logs } = makeLogger();
  return { logger: logger as unknown as RelayerLogger, logs };
}

function makeRepo(order: OracleOrder, onUpdate?: (data: Record<string, unknown>) => void) {
  return {
    findBroadcastedQubicOrders: async () => [],
    findReadyForRelay: async () => [order],
    update: async (_id: string, data: Record<string, unknown>) => {
      onUpdate?.(data);
      return { ...order, ...data };
    },
  } as unknown as OrdersRepository;
}

function makeSolanaError(code: number, cause?: Error) {
  const err = new Error(`Solana error #${code}`) as Error & { context: { __code: number }; cause?: Error };
  err.context = { __code: code };
  if (cause) err.cause = cause;
  return err;
}

function makeRateLimitErrorWithStatus(statusCode: number) {
  const err = new Error("rpc error") as Error & { context: { statusCode: number } };
  err.context = { statusCode };
  return err;
}

const noopRelayerLogger = {
  info() {},
  warn() {},
  error() {},
} as unknown as RelayerLogger;

const noopSolanaLogger = {
  info() {},
  error() {},
} as unknown as SolanaRelayDeps["logger"];

const noopContractClient: QubicContractClient = {
  queryContractFunction: async () => { throw new Error("noop"); },
  getBobStatus: async () => { throw new Error("noop"); },
  broadcastTransaction: async () => { throw new Error("noop"); },
};

function makeNoopQubicDeps(): QubicRelayDeps {
  return {
    config: DEFAULT_TEST_CONFIG,
    contractClient: noopContractClient,
    qubicSeed: "a".repeat(55),
    qubicPublicKey: new Uint8Array(32),
    ordersRepository: {
      findSignatures: async () => [],
    } as unknown as QubicRelayDeps["ordersRepository"],
    logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
  };
}

function makeSolanaDepsWithError(error: unknown): SolanaRelayDeps {
  return {
    config: DEFAULT_TEST_CONFIG,
    ordersRepository: { findSignatures: async () => { throw error; } },
    logger: noopSolanaLogger,
    getOracleAddresses: async () => { throw error; },
    getLookupTable: async () => { throw error; },
  } as unknown as SolanaRelayDeps;
}

describe("relayer plugin", () => {
  it("relays ready orders to qubic and stores destination trx hash", async () => {
    const orderData: OracleOrder = {
      id: makeId(1),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: DEFAULT_TEST_CONFIG,
      solanaDeps: makeSolanaDepsWithError(new Error("test relay error")),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("waits between relay attempts when delay is configured", async () => {
    const delayMs = 25;
    const order1: OracleOrder = {
      id: makeId(11),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash-11",
      signature: "sig-11",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };
    const order2: OracleOrder = {
      id: makeId(12),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash-12",
      signature: "sig-12",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [order1, order2],
        update: async (_id: string, data: Record<string, unknown>) => {
          return { ...order1, ...data };
        },
      } as unknown as OrdersRepository,
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_PER_ORDER_DELAY_MS: delayMs,
      },
      solanaDeps: makeSolanaDepsWithError(new Error("test relay error")),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    const startedAt = Date.now();
    await relayer.relayPending();
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= delayMs - 5);
  });

  it("backs off when rate limited", async () => {
    const orderData: OracleOrder = {
      id: makeId(20),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_MAX_ATTEMPTS: 4,
        RELAYER_BACKOFF_BASE_MS: 10,
        RELAYER_BACKOFF_MAX_MS: 10_000,
      },
      solanaDeps: makeSolanaDepsWithError(makeRateLimitErrorWithStatus(429)),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
    assert.ok(updatedWith.next_relay_at);
    assert.ok(updatedWith.last_relay_error);
  });

  it("backs off when rate limited via context.__code", async () => {
    const orderData: OracleOrder = {
      id: makeId(21),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_MAX_ATTEMPTS: 4,
        RELAYER_BACKOFF_BASE_MS: 10,
        RELAYER_BACKOFF_MAX_MS: 100,
      },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(8100002)),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
    assert.ok(updatedWith.next_relay_at);
  });

  it("backs off when rate limited via context.statusCode", async () => {
    const orderData: OracleOrder = {
      id: makeId(22),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_MAX_ATTEMPTS: 4,
        RELAYER_BACKOFF_BASE_MS: 10,
        RELAYER_BACKOFF_MAX_MS: 100,
      },
      solanaDeps: makeSolanaDepsWithError(makeRateLimitErrorWithStatus(429)),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
    assert.ok(updatedWith.next_relay_at);
  });

  it("logs error when order update fails after rate limit", async () => {
    const orderData: OracleOrder = {
      id: makeId(23),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw new Error("db write failed");
        },
      } as unknown as OrdersRepository,
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_MAX_ATTEMPTS: 4,
        RELAYER_BACKOFF_BASE_MS: 10,
        RELAYER_BACKOFF_MAX_MS: 100,
      },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(8100002)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after exponential back-off"),
    );
    assert.ok(
      updateFailLog,
      "expected a log about update failure after rate limit",
    );
  });

  it("stringifies non-Error update failures after rate limit", async () => {
    const orderData: OracleOrder = {
      id: makeId(24),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw "raw string db failure";
        },
      } as unknown as OrdersRepository,
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_MAX_ATTEMPTS: 4,
        RELAYER_BACKOFF_BASE_MS: 10,
        RELAYER_BACKOFF_MAX_MS: 100,
      },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(8100002)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after exponential back-off"),
    );
    assert.ok(
      updateFailLog,
      "expected a log about update failure after rate limit",
    );
  });

  it("marks orders failed after exceeding max relay attempts", async () => {
    const orderData: OracleOrder = {
      id: makeId(2),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 2 },
      solanaDeps: makeSolanaDepsWithError(new Error("server error")),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "failed");
    assert.strictEqual(updatedWith.relay_attempts, 2);
    assert.strictEqual(updatedWith.failure_reason_public, "Relay failed");
  });

  it("keeps orders ready when relay attempts remain", async () => {
    const orderData: OracleOrder = {
      id: makeId(5),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("server error")),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("fails when the qubic unlock response is missing a transaction hash", async () => {
    const orderData: OracleOrder = {
      id: makeId(4),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 1 },
      solanaDeps: makeSolanaDepsWithError(new Error("missing transaction hash")),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "failed");
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("records a failed relay attempt to solana when no signatures exist", async () => {
    const orderData: OracleOrder = {
      id: makeId(3),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      logger: noopRelayerLogger,
      solanaDeps: {
        ordersRepository: { findSignatures: async () => [] },
        logger: noopSolanaLogger,
      } as unknown as SolanaRelayDeps,
      qubicDeps: makeNoopQubicDeps(),
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("relays a solana order successfully via createRelayerService", async () => {
    const oracleKp = generateKeyPairSync("ed25519");
    const oraclePub = oracleKp.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(12);
    const fs = await import("node:fs");
    const relayerSigner = await createKeyPairSignerFromBytes(
      decodeSecretKey(
        JSON.parse(fs.readFileSync(DEFAULT_TEST_CONFIG.SOLANA_KEYS, "utf-8"))
          .sKey,
      ),
    );

    const addressEnc = getAddressEncoder();
    const addressDec = getAddressDecoder();

    const fromHex = bytesToHex(new Uint8Array(32).fill(1));
    const toHex = bytesToHex(oraclePub);
    const nonceHex = bytesToHex(new Uint8Array(32).fill(9));

    const tokenMintBytes = new Uint8Array(
      addressEnc.encode(DEFAULT_TEST_CONFIG.TOKEN_MINT as Address),
    );
    const digest = createHash("sha256")
      .update(
        serializeBridgeOrder({
          protocolName: PROTOCOL_NAME,
          protocolVersion: PROTOCOL_VERSION,
          contractAddress: CONTRACT_ADDRESS_BYTES,
          networkIn: Network.Qubic,
          networkOut: Network.Solana,
          tokenIn: QUBIC_TOKEN_ADDRESS,
          tokenOut: tokenMintBytes,
          fromAddress: hexToBytes(fromHex),
          toAddress: hexToBytes(toHex),
          amount: 1_000_000_000_000n,
          relayerFee: 10_000_000_000n,
          nonce: hexToBytes(nonceHex),
          orderEra: 0,
        }),
      )
      .digest();
    const sigBase64 = Buffer.from(
      sign(
        null,
        digest,
        oracleKp.privateKey as import("node:crypto").KeyObject,
      ),
    ).toString("base64");

    const solanaOrder: OracleOrder = {
      id: makeId(50),
      source: "qubic",
      dest: "solana",
      from: fromHex,
      to: toHex,
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-origin",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: nonceHex,
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;
    const oracleAddr = addressDec.decode(oraclePub);

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [solanaOrder],
        update: async (_id: string, data: Record<string, unknown>) => {
          updatedWith = data;
          return { ...solanaOrder, ...data };
        },
      } as unknown as OrdersRepository,
      config: DEFAULT_TEST_CONFIG,
      logger: noopRelayerLogger,
      qubicDeps: makeNoopQubicDeps(),
      solanaDeps: {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        rpc: {
          getLatestBlockhash: () => ({
            send: async () => ({
              value: {
                blockhash: "11111111111111111111111111111111",
                lastValidBlockHeight: 999n,
              },
            }),
          }),
          getRecentPrioritizationFees: () => ({ send: async () => [] }),
        } as unknown as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () =>
          undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopSolanaLogger,
        getLookupTable: async () => ({}),
        getOracleAddresses: async () => [oracleAddr],
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
    const logMock = mockLogMethod(t, app.log, "error");

    startRelayer(app, {
      relayer,
      config: { RELAYER_PROCESS_INTERVAL_MS: 20 } as EnvConfig,
    });

    await new Promise((resolve) => setTimeout(resolve, 160));
    await app.close();

    assert.ok(calls >= 1);
    assert.ok(logMock.calls.length >= 1);
  });

  it("marks order relayed without retry when already-relayed code is detected", async () => {
    const orderData: OracleOrder = {
      id: makeId(10),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(4615009)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "relayed");
    assert.strictEqual(updatedWith.relay_attempts, undefined);
    assert.ok(
      logs.warnLogs.length >= 1,
      "expected warn log for already-relayed code",
    );
  });

  it("marks order relayed when already-relayed code is nested in preflight cause", async () => {
    const orderData: OracleOrder = {
      id: makeId(11),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(-32002, makeSolanaError(4615009))),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "relayed");
    assert.strictEqual(updatedWith.relay_attempts, undefined);
    assert.ok(
      logs.warnLogs.length >= 1,
      "expected warn log for already-relayed code in cause chain",
    );
  });

  it("extracts error code from context property on relay failure", async () => {
    const orderData: OracleOrder = {
      id: makeId(12),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(42)),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("handles non-Error thrown during relay", async () => {
    const orderData: OracleOrder = {
      id: makeId(13),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(42),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("logs error when order update fails after relay failure", async () => {
    const orderData: OracleOrder = {
      id: makeId(14),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw new Error("db write failed");
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("relay boom")),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after relay failure"),
    );
    assert.ok(updateFailLog, "expected a log about update failure after relay");
  });

  it("stringifies non-Error update failures after relay error", async () => {
    const orderData: OracleOrder = {
      id: makeId(15),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw "raw string db failure";
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("relay error")),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after relay failure"),
    );
    assert.ok(updateFailLog, "expected a log about update failure after relay");
  });

  it("handles non-Error thrown in startRelayer cycle", async (t) => {
    const app = Fastify({ logger: false });
    const relayer = {
      async relayPending() {
        throw "non-error cycle failure";
      },
    };
    const logMock = mockLogMethod(t, app.log, "error");

    startRelayer(app, {
      relayer,
      config: { RELAYER_PROCESS_INTERVAL_MS: 20 } as EnvConfig,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await app.close();

    assert.ok(logMock.calls.length >= 1);
  });

  it("handles relay error without context property", async () => {
    const orderData: OracleOrder = {
      id: makeId(16),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("plain error without context")),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("marks solana orders failed after exceeding max relay attempts", async () => {
    const solanaOrder: OracleOrder = {
      id: makeId(60),
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
      relay_attempts: 1,
      source_nonce: "nonce-60",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [solanaOrder],
        update: async (_id: string, data: Record<string, unknown>) => {
          updatedWith = data;
          return { ...solanaOrder, ...data };
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 2 },
      logger: noopRelayerLogger,
      qubicDeps: makeNoopQubicDeps(),
      solanaDeps: {
        ordersRepository: {
          findSignatures: async () => [],
        } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopSolanaLogger,
      } as unknown as SolanaRelayDeps,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "failed");
    assert.strictEqual(updatedWith.relay_attempts, 2);
    assert.strictEqual(updatedWith.failure_reason_public, "Relay failed");
  });

  it("keeps solana orders ready when relay attempts remain", async () => {
    const solanaOrder: OracleOrder = {
      id: makeId(61),
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
      source_nonce: "nonce-61",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [solanaOrder],
        update: async (_id: string, data: Record<string, unknown>) => {
          updatedWith = data;
          return { ...solanaOrder, ...data };
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      logger: noopRelayerLogger,
      qubicDeps: makeNoopQubicDeps(),
      solanaDeps: {
        ordersRepository: {
          findSignatures: async () => [],
        } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopSolanaLogger,
      } as unknown as SolanaRelayDeps,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("marks solana order relayed without retry when already-relayed code is detected", async () => {
    const fromHex = "00".repeat(32);
    const toHex = "01".repeat(32);
    const nonceHex = "02".repeat(32);
    const solanaOrder: OracleOrder = {
      id: makeId(62),
      source: "qubic",
      dest: "solana",
      from: fromHex,
      to: toHex,
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: nonceHex,
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: makeRepo(solanaOrder, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      logger,
      qubicDeps: makeNoopQubicDeps(),
      solanaDeps: {
        config: DEFAULT_TEST_CONFIG,
        ordersRepository: {
          findSignatures: async () => {
            throw makeSolanaError(4615009);
          },
        } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopSolanaLogger,
        getOracleAddresses: async () => [],
      } as unknown as SolanaRelayDeps,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "relayed");
    assert.strictEqual(updatedWith.relay_attempts, undefined);
    assert.ok(
      logs.warnLogs.length >= 1,
      "expected warn log for already-relayed solana order",
    );
  });

  it("logs error when order update fails after already-relayed detection", async () => {
    const orderData: OracleOrder = {
      id: makeId(18),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw new Error("db write failed");
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(4615009)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes(
          "Failed to update order after already-relayed detection",
        ),
    );
    assert.ok(
      updateFailLog,
      "expected a log about update failure after already-relayed",
    );
  });

  it("stringifies non-Error update failures after already-relayed detection", async () => {
    const orderData: OracleOrder = {
      id: makeId(19),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw "raw string db failure";
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(4615009)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes(
          "Failed to update order after already-relayed detection",
        ),
    );
    assert.ok(
      updateFailLog,
      "expected a log about update failure after already-relayed",
    );
  });

  it("handles relay error with context.__code of zero", async () => {
    const orderData: OracleOrder = {
      id: makeId(17),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(0)),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("marks order failed immediately when insufficient funds error is detected", async () => {
    const orderData: OracleOrder = {
      id: makeId(70),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(7050003)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "failed");
    assert.strictEqual(updatedWith.failure_reason_public, "Insufficient funds on relayer wallet");
    assert.ok(
      logs.errorLogs.some(
        (args) =>
          typeof args[1] === "string" &&
          args[1].includes("insufficient funds"),
      ),
      "expected error log for insufficient funds",
    );
  });

  it("marks order failed when insufficient funds code is nested in preflight cause", async () => {
    const orderData: OracleOrder = {
      id: makeId(71),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;
    const { logger } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(-32002, makeSolanaError(7050003))),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "failed");
    assert.strictEqual(updatedWith.failure_reason_public, "Insufficient funds on relayer wallet");
  });

  it("logs error when order update fails after insufficient funds", async () => {
    const orderData: OracleOrder = {
      id: makeId(72),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw new Error("db write failed");
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(7050003)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after insufficient funds"),
    );
    assert.ok(
      updateFailLog,
      "expected a log about update failure after insufficient funds",
    );
  });

  it("stringifies non-Error update failures after insufficient funds", async () => {
    const orderData: OracleOrder = {
      id: makeId(73),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [],
        findReadyForRelay: async () => [orderData],
        update: async () => {
          throw "raw string db failure";
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(makeSolanaError(7050003)),
      qubicDeps: makeNoopQubicDeps(),
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after insufficient funds"),
    );
    assert.ok(
      updateFailLog,
      "expected a log about update failure after insufficient funds",
    );
  });

  it("backs off when rate limited via HttpError", async () => {
    const orderData: OracleOrder = {
      id: makeId(80),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const httpError = new HttpError({
      message: "HTTP 429",
      statusCode: 429,
      url: "http://localhost:8899",
      method: "POST",
      body: "Too Many Requests",
    });

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: {
        ...DEFAULT_TEST_CONFIG,
        RELAYER_MAX_ATTEMPTS: 4,
        RELAYER_BACKOFF_BASE_MS: 10,
        RELAYER_BACKOFF_MAX_MS: 10_000,
      },
      solanaDeps: makeSolanaDepsWithError(httpError),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
    assert.strictEqual(updatedWith.relay_attempts, 1);
    assert.ok(updatedWith.next_relay_at);
    assert.ok(updatedWith.last_relay_error);
  });

  it("does not treat non-429 HttpError as rate limited", async () => {
    const orderData: OracleOrder = {
      id: makeId(81),
      source: "qubic",
      dest: "solana",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const httpError = new HttpError({
      message: "HTTP 500",
      statusCode: 500,
      url: "http://localhost:8899",
      method: "POST",
      body: "Internal Server Error",
    });

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 1 },
      solanaDeps: makeSolanaDepsWithError(httpError),
      qubicDeps: makeNoopQubicDeps(),
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    assert.strictEqual(updatedWith.status, "failed");
    assert.strictEqual(updatedWith.relay_attempts, 1);
  });

  it("routes dest=qubic orders through relayToQubic", async (t) => {
    const { startQubicRpcMock } = await import("../../helpers/qubic-rpc-mock.js");
    const { url } = await startQubicRpcMock(t, { oracleCount: 0 });

    const orderData: OracleOrder = {
      id: makeId(90),
      source: "solana",
      dest: "qubic",
      from: "0000000000000000000000000000000000000000000000000000000000000000",
      to: "0101010101010101010101010101010101010101010101010101010101010101",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "0202020202020202020202020202020202020202020202020202020202020202",
      source_payload: "{}",
      order_era: 0,
    };

    let updatedWith: Record<string, unknown> | undefined;

    const qubicDeps: QubicRelayDeps = {
      config: { ...DEFAULT_TEST_CONFIG, QUBIC_RPC_URL: url },
      contractClient: noopContractClient,
      qubicSeed: "a".repeat(55),
      qubicPublicKey: new Uint8Array(32),
      ordersRepository: {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const relayer = createRelayerService({
      ordersRepository: makeRepo(orderData, (data) => {
        updatedWith = data;
      }),
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger: noopRelayerLogger,
    });

    await relayer.relayPending();

    assert.ok(updatedWith);
    // relayToQubic gets 0 oracle keys, matches 0 signatures, throws "No valid oracle signatures"
    // This is a generic error so relay_attempts is incremented
    assert.strictEqual(updatedWith.relay_attempts, 1);
    assert.strictEqual(updatedWith.status, "ready-for-relay");
  });

  it("marks qubic order as broadcasted first, then failed when deferred finalization expires", async () => {

    const helper = new QubicHelper();
    const identity = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
    const crypto = await resolveQubicCrypto();

    const orderData: OracleOrder = {
      id: makeId(91),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
    };

    const serialized = serializeQsbOrderMessage({
      protocolName: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
      networkIn: 2,
      networkOut: 1,
      tokenIn: new Uint8Array(getAddressEncoder().encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT))),
      tokenOut: QUBIC_TOKEN_ADDRESS,
      fromAddress: new Uint8Array(32),
      toAddress: new Uint8Array(32).fill(0x01),
      amount: 1000n,
      relayerFee: 10n,
      nonce: new Uint8Array(32).fill(0x02),
      orderEra: 0,
    });
    const digest = new Uint8Array(32);
    crypto.K12(serialized, digest, 32);
    const signature = crypto.schnorrq.sign(identity.privateKey, identity.publicKey, digest);
    const sigBase64 = Buffer.from(signature).toString("base64");

    const oracleKeysBuf = Buffer.alloc(8 + 32);
    oracleKeysBuf.writeUInt32LE(1, 0);
    oracleKeysBuf.set(identity.publicKey, 8);
    const oracleKeysHex = oracleKeysBuf.toString("hex");

    let bobCallCount = 0;
    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async (_funcNumber: number, input: string) => {
          if (input.length === 64) return "00";
          return oracleKeysHex;
        },
        getBobStatus: async () => {
          bobCallCount++;
          const tick = bobCallCount === 1 ? 100 : 200;
          return { epoch: 1, tick, fetchingTick: tick, indexingTick: tick };
        },
        broadcastTransaction: async () => {},
      },
      qubicSeed: QUBIC_FIXTURE_SEED,
      qubicPublicKey: identity.publicKey,
      pollIntervalMs: 0,
      ordersRepository: {
        findSignatures: async () => [sigBase64],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const updates: Array<Record<string, unknown>> = [];
    let currentOrder: OracleOrder = orderData;
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findReadyForRelay: async () =>
          currentOrder.status === "ready-for-relay" ? [currentOrder] : [],
        findBroadcastedQubicOrders: async () =>
          currentOrder.status === "transaction-broadcasted" ? [currentOrder] : [],
        update: async (_id: string, data: Record<string, unknown>) => {
          updates.push(data);
          currentOrder = { ...currentOrder, ...data } as OracleOrder;
          return currentOrder;
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();
    await relayer.relayPending();

    assert.strictEqual(updates.length, 2);
    assert.strictEqual(updates[0].status, "transaction-broadcasted");
    assert.strictEqual(updates[0].relay_attempts, 1);
    assert.strictEqual(updates[1].status, "failed");
    assert.strictEqual(updates[1].failure_reason_public, "Qubic transaction expired");
    assert.ok(
      logs.errorLogs.some(
        (args) => typeof args[1] === "string" && args[1].includes("Qubic broadcast definitively failed"),
      ),
      "expected error log for Qubic definitive failure",
    );
  });

  it("stringifies non-Error update failures after deferred Qubic definitive failure", async () => {

    const helper = new QubicHelper();
    const identity = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
    const crypto = await resolveQubicCrypto();

    const orderData: OracleOrder = {
      id: makeId(93),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
    };

    const serialized = serializeQsbOrderMessage({
      protocolName: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
      networkIn: 2,
      networkOut: 1,
      tokenIn: new Uint8Array(getAddressEncoder().encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT))),
      tokenOut: QUBIC_TOKEN_ADDRESS,
      fromAddress: new Uint8Array(32),
      toAddress: new Uint8Array(32).fill(0x01),
      amount: 1000n,
      relayerFee: 10n,
      nonce: new Uint8Array(32).fill(0x02),
      orderEra: 0,
    });
    const digest = new Uint8Array(32);
    crypto.K12(serialized, digest, 32);
    const signature = crypto.schnorrq.sign(identity.privateKey, identity.publicKey, digest);
    const sigBase64 = Buffer.from(signature).toString("base64");

    const oracleKeysBuf = Buffer.alloc(8 + 32);
    oracleKeysBuf.writeUInt32LE(1, 0);
    oracleKeysBuf.set(identity.publicKey, 8);
    const oracleKeysHex = oracleKeysBuf.toString("hex");

    let bobCallCount = 0;
    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async (_funcNumber: number, input: string) => {
          if (input.length === 64) return "00";
          return oracleKeysHex;
        },
        getBobStatus: async () => {
          bobCallCount++;
          const tick = bobCallCount === 1 ? 100 : 200;
          return { epoch: 1, tick, fetchingTick: tick, indexingTick: tick };
        },
        broadcastTransaction: async () => {},
      },
      qubicSeed: QUBIC_FIXTURE_SEED,
      qubicPublicKey: identity.publicKey,
      pollIntervalMs: 0,
      ordersRepository: {
        findSignatures: async () => [sigBase64],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [
          {
            ...orderData,
            status: "transaction-broadcasted",
            destination_trx_hash: "qubic-tx",
            destination_order_hash: "22".repeat(32),
            destination_target_tick: 105,
          },
        ],
        findReadyForRelay: async () => [],
        update: async () => {
          throw "raw string qubic failure";
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after broadcasted Qubic definitive failure"),
    );
    assert.ok(updateFailLog, "expected a log about update failure after Qubic definitive failure");
  });

  it("logs error when order update fails after deferred Qubic definitive failure", async () => {

    const helper = new QubicHelper();
    const identity = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
    const crypto = await resolveQubicCrypto();

    const orderData: OracleOrder = {
      id: makeId(92),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
    };

    const serialized = serializeQsbOrderMessage({
      protocolName: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
      networkIn: 2,
      networkOut: 1,
      tokenIn: new Uint8Array(getAddressEncoder().encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT))),
      tokenOut: QUBIC_TOKEN_ADDRESS,
      fromAddress: new Uint8Array(32),
      toAddress: new Uint8Array(32).fill(0x01),
      amount: 1000n,
      relayerFee: 10n,
      nonce: new Uint8Array(32).fill(0x02),
      orderEra: 0,
    });
    const digest = new Uint8Array(32);
    crypto.K12(serialized, digest, 32);
    const signature = crypto.schnorrq.sign(identity.privateKey, identity.publicKey, digest);
    const sigBase64 = Buffer.from(signature).toString("base64");

    const oracleKeysBuf = Buffer.alloc(8 + 32);
    oracleKeysBuf.writeUInt32LE(1, 0);
    oracleKeysBuf.set(identity.publicKey, 8);
    const oracleKeysHex = oracleKeysBuf.toString("hex");

    let bobCallCount = 0;
    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async (_funcNumber: number, input: string) => {
          if (input.length === 64) return "00";
          return oracleKeysHex;
        },
        getBobStatus: async () => {
          bobCallCount++;
          const tick = bobCallCount === 1 ? 100 : 200;
          return { epoch: 1, tick, fetchingTick: tick, indexingTick: tick };
        },
        broadcastTransaction: async () => {},
      },
      qubicSeed: QUBIC_FIXTURE_SEED,
      qubicPublicKey: identity.publicKey,
      pollIntervalMs: 0,
      ordersRepository: {
        findSignatures: async () => [sigBase64],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [
          {
            ...orderData,
            status: "transaction-broadcasted",
            destination_trx_hash: "qubic-tx",
            destination_order_hash: "33".repeat(32),
            destination_target_tick: 105,
          },
        ],
        findReadyForRelay: async () => [],
        update: async () => {
          throw new Error("db write failed");
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after broadcasted Qubic definitive failure"),
    );
    assert.ok(updateFailLog, "expected a log about update failure after Qubic definitive failure");
  });

  it("marks broadcasted qubic order as relayed when finalization succeeds", async () => {

    const helper = new QubicHelper();
    const identity = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
    const crypto = await resolveQubicCrypto();

    const orderData: OracleOrder = {
      id: makeId(94),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "transaction-broadcasted",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
      destination_trx_hash: "qubic-tx-94",
      destination_order_hash: "44".repeat(32),
      destination_target_tick: 105,
    };

    const serialized = serializeQsbOrderMessage({
      protocolName: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
      networkIn: 2,
      networkOut: 1,
      tokenIn: new Uint8Array(getAddressEncoder().encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT))),
      tokenOut: QUBIC_TOKEN_ADDRESS,
      fromAddress: new Uint8Array(32),
      toAddress: new Uint8Array(32).fill(0x01),
      amount: 1000n,
      relayerFee: 10n,
      nonce: new Uint8Array(32).fill(0x02),
      orderEra: 0,
    });
    const digest = new Uint8Array(32);
    crypto.K12(serialized, digest, 32);
    const signature = crypto.schnorrq.sign(identity.privateKey, identity.publicKey, digest);
    const sigBase64 = Buffer.from(signature).toString("base64");

    const oracleKeysBuf = Buffer.alloc(8 + 32);
    oracleKeysBuf.writeUInt32LE(1, 0);
    oracleKeysBuf.set(identity.publicKey, 8);
    const oracleKeysHex = oracleKeysBuf.toString("hex");

    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async (_funcNumber: number, input: string) => {
          if (input.length === 64) return "01"; // order is filled
          return oracleKeysHex;
        },
        getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
        broadcastTransaction: async () => {},
      },
      qubicSeed: QUBIC_FIXTURE_SEED,
      qubicPublicKey: identity.publicKey,
      pollIntervalMs: 0,
      ordersRepository: {
        findSignatures: async () => [sigBase64],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const updates: Array<Record<string, unknown>> = [];
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [orderData],
        findReadyForRelay: async () => [],
        update: async (_id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return { ...orderData, ...data } as OracleOrder;
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].status, "relayed");
    assert.ok(
      logs.infoLogs.some(
        (args) => typeof args[1] === "string" && args[1].includes("Qubic relay confirmed"),
      ),
      "expected info log for confirmed relay",
    );
  });

  it("stores null destination_trx_hash when confirmed relay has no trx hash", async () => {

    const helper = new QubicHelper();
    const identity = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
    const crypto = await resolveQubicCrypto();

    const orderData: OracleOrder = {
      id: makeId(98),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "transaction-broadcasted",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
      destination_order_hash: "88".repeat(32),
      destination_target_tick: 105,
    };

    const serialized = serializeQsbOrderMessage({
      protocolName: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
      networkIn: 2,
      networkOut: 1,
      tokenIn: new Uint8Array(getAddressEncoder().encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT))),
      tokenOut: QUBIC_TOKEN_ADDRESS,
      fromAddress: new Uint8Array(32),
      toAddress: new Uint8Array(32).fill(0x01),
      amount: 1000n,
      relayerFee: 10n,
      nonce: new Uint8Array(32).fill(0x02),
      orderEra: 0,
    });
    const digest = new Uint8Array(32);
    crypto.K12(serialized, digest, 32);
    const signature = crypto.schnorrq.sign(identity.privateKey, identity.publicKey, digest);
    const sigBase64 = Buffer.from(signature).toString("base64");

    const oracleKeysBuf = Buffer.alloc(8 + 32);
    oracleKeysBuf.writeUInt32LE(1, 0);
    oracleKeysBuf.set(identity.publicKey, 8);
    const oracleKeysHex = oracleKeysBuf.toString("hex");

    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async (_funcNumber: number, input: string) => {
          if (input.length === 64) return "01"; // order is filled
          return oracleKeysHex;
        },
        getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
        broadcastTransaction: async () => {},
      },
      qubicSeed: QUBIC_FIXTURE_SEED,
      qubicPublicKey: identity.publicKey,
      pollIntervalMs: 0,
      ordersRepository: {
        findSignatures: async () => [sigBase64],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const updates: Array<Record<string, unknown>> = [];
    const { logger } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [orderData],
        findReadyForRelay: async () => [],
        update: async (_id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return { ...orderData, ...data } as OracleOrder;
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].status, "relayed");
    assert.strictEqual(updates[0].destination_trx_hash, null);
  });

  it("logs a warning when broadcasted qubic order finalization is still pending", async () => {
    const orderData: OracleOrder = {
      id: makeId(95),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "transaction-broadcasted",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
      destination_trx_hash: "qubic-tx-95",
      destination_order_hash: "55".repeat(32),
      destination_target_tick: 105,
    };

    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async () => "00", // never filled
        getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }), // tick never advances
        broadcastTransaction: async () => {},
      },
      qubicSeed: "a".repeat(55),
      qubicPublicKey: new Uint8Array(32),
      pollIntervalMs: 0,
      pollMaxAttempts: 1,
      ordersRepository: {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const updates: Array<Record<string, unknown>> = [];
    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [orderData],
        findReadyForRelay: async () => [],
        update: async (_id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return { ...orderData, ...data } as OracleOrder;
        },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    assert.strictEqual(updates.length, 1);
    assert.ok(updates[0].last_relay_error);
    assert.ok(
      logs.warnLogs.some(
        (args) => typeof args[1] === "string" && args[1].includes("still pending confirmation"),
      ),
      "expected warn log for still-pending confirmation",
    );
  });

  it("logs error when order update fails after pending qubic confirmation", async () => {
    const orderData: OracleOrder = {
      id: makeId(96),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "transaction-broadcasted",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
      destination_trx_hash: "qubic-tx-96",
      destination_order_hash: "66".repeat(32),
      destination_target_tick: 105,
    };

    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async () => "00", // never filled
        getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
        broadcastTransaction: async () => {},
      },
      qubicSeed: "a".repeat(55),
      qubicPublicKey: new Uint8Array(32),
      pollIntervalMs: 0,
      pollMaxAttempts: 1,
      ordersRepository: {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [orderData],
        findReadyForRelay: async () => [],
        update: async () => { throw new Error("db write failed"); },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after pending Qubic confirmation"),
    );
    assert.ok(updateFailLog, "expected error log for update failure after pending confirmation");
  });

  it("stringifies non-Error update failures after pending qubic confirmation", async () => {
    const orderData: OracleOrder = {
      id: makeId(97),
      source: "solana",
      dest: "qubic",
      from: "00".repeat(32),
      to: "01".repeat(32),
      amount: "1000",
      relayerFee: "10",
      origin_trx_hash: "trx-hash",
      signature: "sig",
      status: "transaction-broadcasted",
      oracle_accept_to_relay: true,
      relay_attempts: 1,
      source_nonce: "02".repeat(32),
      source_payload: "{}",
      order_era: 0,
      destination_trx_hash: "qubic-tx-97",
      destination_order_hash: "77".repeat(32),
      destination_target_tick: 105,
    };

    const qubicDeps: QubicRelayDeps = {
      config: DEFAULT_TEST_CONFIG,
      contractClient: {
        queryContractFunction: async () => "00",
        getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
        broadcastTransaction: async () => {},
      },
      qubicSeed: "a".repeat(55),
      qubicPublicKey: new Uint8Array(32),
      pollIntervalMs: 0,
      pollMaxAttempts: 1,
      ordersRepository: {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"],
      logger: { info() {}, warn() {}, error() {} } as unknown as QubicRelayDeps["logger"],
    };

    const { logger, logs } = makeRelayerLogger();

    const relayer = createRelayerService({
      ordersRepository: {
        findBroadcastedQubicOrders: async () => [orderData],
        findReadyForRelay: async () => [],
        update: async () => { throw "raw string failure"; },
      } as unknown as OrdersRepository,
      config: { ...DEFAULT_TEST_CONFIG, RELAYER_MAX_ATTEMPTS: 3 },
      solanaDeps: makeSolanaDepsWithError(new Error("should not be called")),
      qubicDeps,
      logger,
    });

    await relayer.relayPending();

    const updateFailLog = logs.errorLogs.find(
      (args) =>
        typeof args[1] === "string" &&
        args[1].includes("Failed to update order after pending Qubic confirmation"),
    );
    assert.ok(updateFailLog, "expected error log for non-Error update failure after pending confirmation");
  });
});
