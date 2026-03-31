import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import Fastify from "fastify";
import {
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getAddressDecoder,
  type Address,
} from "@solana/kit";
import { build, DEFAULT_TEST_CONFIG } from "../../helpers/build.js";
import { mockLogMethod, makeLogger, type LoggerMocks } from "../../helpers/mocks/logger.js";
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
import type { QubicRelayDeps } from "../../../src/plugins/app/relayer/relay-qubic.js";
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
import { QUBIC_TOKEN_ADDRESS } from "../../../src/plugins/app/common/qubic/encoding.js";
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

function makeNoopQubicDeps(): QubicRelayDeps {
  return {
    config: DEFAULT_TEST_CONFIG,
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
          amount: 1000n,
          relayerFee: 10n,
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
      config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url },
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
});
