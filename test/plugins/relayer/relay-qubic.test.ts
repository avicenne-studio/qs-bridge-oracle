import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import Fastify from "fastify";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import qubicCryptoModule from "@qubic-lib/qubic-ts-library";

import {
  relayToQubic,
  buildQubicRelayDeps,
  type QubicRelayDeps,
} from "../../../src/plugins/app/relayer/relay-qubic.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../../../src/plugins/app/common/protocol.js";
import {
  QUBIC_CONTRACT_ADDRESS_BYTES,
  QUBIC_TOKEN_ADDRESS,
} from "../../../src/plugins/app/common/qubic/encoding.js";
import { serializeBridgeOrder } from "../../../src/plugins/app/common/solana/program.js";
import type { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";
import { build, DEFAULT_TEST_CONFIG } from "../../helpers/build.js";
import { address, getAddressEncoder } from "@solana/kit";

const addressEncoder = getAddressEncoder();
const TOKEN_MINT_BYTES = new Uint8Array(addressEncoder.encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT)));

type QubicCrypto = {
  schnorrq: {
    sign: (sk: Uint8Array, pk: Uint8Array, msg: Uint8Array) => Uint8Array;
    verify: (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => number;
  };
  K12: (input: Uint8Array, output: Uint8Array, outputLength: number) => void;
};

const resolvedCrypto = (
  qubicCryptoModule as unknown as { default: { crypto: Promise<QubicCrypto> } }
).default.crypto;

// Fixture keys from test/fixtures/signer/qubic.keys.json
const QUBIC_FIXTURE_SEED = "aoftkmcshcjliulcifkpojwhxpmagekmxygsdiqdlwtgkxqsymsyovl";

const noopLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return noopLogger;
  },
} as unknown as QubicRelayDeps["logger"];

function makeQubicOrder(overrides: Partial<OracleOrder> = {}): OracleOrder {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "solana",
    dest: "qubic",
    from: "00".repeat(32),
    to: "00".repeat(32),
    amount: "1000",
    relayerFee: "10",
    origin_trx_hash: "trx-origin-hash",
    signature: "sig-placeholder",
    status: "ready-for-relay",
    oracle_accept_to_relay: true,
    relay_attempts: 0,
    source_nonce: "00".repeat(32),
    source_payload: "{}",
    order_era: 0,
    ...overrides,
  };
}

/**
 * Starts a custom mock Qubic RPC server that returns the given oracle public key
 * in the querySmartContract response.
 */
async function startCustomRpcMock(
  t: import("node:test").TestContext,
  opts: {
    oraclePublicKey?: Uint8Array;
    broadcastResult?: "success" | "fail";
    broadcastStatusCode?: number;
    tickInfoResult?: "success" | "fail";
    querySmartContractResult?: "success" | "fail";
  } = {},
) {
  const { broadcastResult = "success", broadcastStatusCode = 500 } = opts;
  const { tickInfoResult = "success", querySmartContractResult = "success" } = opts;
  const server = Fastify({ logger: false });

  server.get("/live/v1/tick-info", async (_req, reply) => {
    if (tickInfoResult === "fail") {
      return reply.code(503).send("service unavailable");
    }
    return { tick: 100, epoch: 1 };
  });

  server.post("/live/v1/querySmartContract", async (_req, reply) => {
    if (querySmartContractResult === "fail") {
      return reply.code(502).send("bad gateway");
    }
    const buf = Buffer.alloc(4 + 64 * 32);
    if (opts.oraclePublicKey) {
      buf.writeUInt32LE(1, 0);
      buf.set(opts.oraclePublicKey, 4);
    } else {
      buf.writeUInt32LE(0, 0);
    }
    return { responseData: buf.toString("base64") };
  });

  server.post("/broadcastTransaction", async (_req, reply) => {
    if (broadcastResult === "fail") {
      return reply.code(broadcastStatusCode).send("broadcast failed");
    }
    return { transactionId: "qubic-tx-1", peersBroadcasted: 3 };
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

async function loadQubicIdentity() {
  const helper = new QubicHelper();
  const idPackage = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
  return idPackage;
}

async function signOrder(order: OracleOrder): Promise<string> {
  const { privateKey, publicKey } = await loadQubicIdentity();
  const crypto = await resolvedCrypto;

  const fromBytes = Buffer.from(order.from.replace(/^0x/, ""), "hex");
  const toBytes = Buffer.from(order.to.replace(/^0x/, ""), "hex");
  const nonceHex = order.source_nonce.replace(/^0x/, "");
  const nonceBytes = new Uint8Array(32);
  nonceBytes.set(Buffer.from(nonceHex, "hex").subarray(0, 32));

  const networkIn = order.source === "qubic" ? 1 : 2;
  const networkOut = order.dest === "qubic" ? 1 : 2;

  const serialized = serializeBridgeOrder({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
    networkIn,
    networkOut,
    tokenIn: TOKEN_MINT_BYTES,
    tokenOut: QUBIC_TOKEN_ADDRESS,
    fromAddress: new Uint8Array(fromBytes),
    toAddress: new Uint8Array(toBytes),
    amount: BigInt(order.amount),
    relayerFee: BigInt(order.relayerFee),
    nonce: nonceBytes,
    orderEra: order.order_era,
  });

  const digest = new Uint8Array(32);
  crypto.K12(serialized, digest, 32);

  const signature = crypto.schnorrq.sign(privateKey, publicKey, digest);
  return Buffer.from(signature).toString("base64");
}

describe("relay-qubic", () => {
  describe("relayToQubic", () => {
    it("succeeds with a valid oracle signature and broadcast", async (t) => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const { url } = await startCustomRpcMock(t, {
        oraclePublicKey: identity.publicKey,
        broadcastResult: "success",
      });

      const deps: QubicRelayDeps = {
        config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url, QUBIC_RPC_URL: url },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await relayToQubic(order, deps);
      assert.ok(result.trxHash.length > 0, "trxHash should be non-empty");
    });

    it("throws when no signatures match any oracle", async (t) => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();

      const { url } = await startCustomRpcMock(t, {
        oraclePublicKey: identity.publicKey,
        broadcastResult: "success",
      });

      const deps: QubicRelayDeps = {
        config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url, QUBIC_RPC_URL: url },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        ordersRepository: {
          findSignatures: async () => [],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => relayToQubic(order, deps),
        { message: "No valid oracle signatures could be matched" },
      );
    });

    it("throws on broadcast failure", async (t) => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const { url } = await startCustomRpcMock(t, {
        oraclePublicKey: identity.publicKey,
        broadcastResult: "fail",
        broadcastStatusCode: 500,
      });

      const deps: QubicRelayDeps = {
        config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url, QUBIC_RPC_URL: url },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => relayToQubic(order, deps),
        /Qubic broadcast failed/,
      );
    });

    it("throws when tick-info endpoint returns an error", async (t) => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const { url } = await startCustomRpcMock(t, {
        oraclePublicKey: identity.publicKey,
        tickInfoResult: "fail",
      });

      const deps: QubicRelayDeps = {
        config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url, QUBIC_RPC_URL: url },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => relayToQubic(order, deps),
        /tick-info HTTP 503/,
      );
    });

    it("throws when querySmartContract endpoint returns an error", async (t) => {
      const order = makeQubicOrder();

      const { url } = await startCustomRpcMock(t, {
        querySmartContractResult: "fail",
      });

      const deps: QubicRelayDeps = {
        config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url, QUBIC_RPC_URL: url },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: new Uint8Array(32),
        ordersRepository: {
          findSignatures: async () => ["AAAA"],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => relayToQubic(order, deps),
        /GetOracles HTTP 502/,
      );
    });

    it("skips signatures with invalid length", async (t) => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();

      // A signature that is not 64 bytes (too short)
      const shortSig = Buffer.from(new Uint8Array(32)).toString("base64");

      const { url } = await startCustomRpcMock(t, {
        oraclePublicKey: identity.publicKey,
        broadcastResult: "success",
      });

      const deps: QubicRelayDeps = {
        config: { ...DEFAULT_TEST_CONFIG, QUBIC_BROADCAST_RPC_URL: url, QUBIC_RPC_URL: url },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        ordersRepository: {
          findSignatures: async () => [shortSig],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => relayToQubic(order, deps),
        { message: "No valid oracle signatures could be matched" },
      );
    });
  });

  describe("buildQubicRelayDeps", () => {
    it("returns deps with config, seed, publicKey and ordersRepository", async (t) => {
      const app = await build(t, { config: { RELAYER_ENABLED: false } });

      const mockOrdersRepository = {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"];

      const config = DEFAULT_TEST_CONFIG;
      const deps = await buildQubicRelayDeps(app, config, mockOrdersRepository);

      assert.strictEqual(deps.config, config);
      assert.strictEqual(typeof deps.qubicSeed, "string");
      assert.ok(deps.qubicSeed.length > 0, "qubicSeed should be non-empty");
      assert.ok(deps.qubicPublicKey instanceof Uint8Array, "qubicPublicKey should be a Uint8Array");
      assert.strictEqual(deps.qubicPublicKey.length, 32);
      assert.strictEqual(deps.ordersRepository, mockOrdersRepository);
      assert.ok(deps.logger, "logger should be set");
    });
  });
});
