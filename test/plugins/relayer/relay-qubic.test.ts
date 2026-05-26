import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { resolveQubicCrypto, QUBIC_FIXTURE_SEED } from "../../helpers/qubic-crypto.js";

import {
  relayToQubic,
  finalizeQubicRelay,
  buildQubicRelayDeps,
  QubicDefinitiveRelayFailure,
  type QubicRelayDeps,
} from "../../../src/plugins/app/relayer/relay-qubic.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../../../src/plugins/app/common/protocol.js";
import {
  QUBIC_CONTRACT_ADDRESS_BYTES,
  QUBIC_TOKEN_ADDRESS,
} from "../../../src/plugins/app/common/qubic/encoding.js";
import { serializeQsbOrderMessage } from "../../../src/plugins/app/common/qubic/qsb-message.js";
import type { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";
import type { QubicContractClient } from "../../../src/plugins/infra/qubic-contract-client.js";
import { build, DEFAULT_TEST_CONFIG } from "../../helpers/build.js";
import { address, getAddressEncoder } from "@solana/kit";

const addressEncoder = getAddressEncoder();
const TOKEN_MINT_BYTES = new Uint8Array(addressEncoder.encode(address(DEFAULT_TEST_CONFIG.TOKEN_MINT)));


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

async function loadQubicIdentity() {
  const helper = new QubicHelper();
  const idPackage = await helper.createIdPackage(QUBIC_FIXTURE_SEED);
  return idPackage;
}

async function signOrder(order: OracleOrder): Promise<string> {
  const { privateKey, publicKey } = await loadQubicIdentity();
  const crypto = await resolveQubicCrypto();

  const fromBytes = Buffer.from(order.from.replace(/^0x/, ""), "hex");
  const toBytes = Buffer.from(order.to.replace(/^0x/, ""), "hex");
  const nonceHex = order.source_nonce.replace(/^0x/, "");
  const nonceBytes = new Uint8Array(32);
  nonceBytes.set(Buffer.from(nonceHex, "hex").subarray(0, 32));

  const networkIn = order.source === "qubic" ? 1 : 2;
  const networkOut = order.dest === "qubic" ? 1 : 2;

  const serialized = serializeQsbOrderMessage({
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

// GetOracles response: u32 count (4B) + u32 padding (4B) + key (32B each)
function buildOracleKeysHex(key?: Uint8Array): string {
  const buf = Buffer.alloc(8 + 32);
  if (key) {
    buf.writeUInt32LE(1, 0);
    buf.set(key, 8);
  }
  return buf.toString("hex");
}

function makeContractClient(opts: {
  oraclePublicKey?: Uint8Array;
  broadcastResult?: "fail";
  tickResult?: "fail";
  queryResult?: "fail";
  isOrderFilledResult?: "filled" | "not-filled";
} = {}): QubicContractClient {
  return {
    queryContractFunction: async (_funcNumber: number, input: string) => {
      if (opts.queryResult === "fail") throw new Error("GetOracles HTTP 502");
      // FUNC_IS_ORDER_FILLED has a 32-byte input; FUNC_GET_ORACLES has empty input
      if (input.length === 64) {
        if (opts.isOrderFilledResult === "not-filled") return "00".repeat(1);
        return buildOracleKeysHex(opts.oraclePublicKey); // first byte = count = 1 = filled
      }
      return buildOracleKeysHex(opts.oraclePublicKey);
    },
    getBobStatus: async () => {
      if (opts.tickResult === "fail") throw new Error("getBobStatus failed: HTTP 503");
      return { epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 };
    },
    broadcastTransaction: async () => {
      if (opts.broadcastResult === "fail") {
        throw new Error("Qubic broadcast failed: HTTP 500 — \"broadcast failed\"");
      }
    },
  };
}

describe("relay-qubic", () => {
  describe("relayToQubic", () => {
    it("succeeds with a valid oracle signature and broadcast", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ oraclePublicKey: identity.publicKey }),
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollIntervalMs: 0,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await relayToQubic(order, deps);
      assert.ok(result.trxHash.length > 0, "trxHash should be non-empty");
    });

    it("does not reuse an oracle for duplicate signatures", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ oraclePublicKey: identity.publicKey }),
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollIntervalMs: 0,
        ordersRepository: {
          findSignatures: async () => [sigBase64, sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await relayToQubic(order, deps);
      assert.ok(result.trxHash.length > 0, "trxHash should be non-empty");
    });

    it("throws when no signatures match any oracle", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ oraclePublicKey: identity.publicKey }),
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

    it("throws on broadcast failure", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ oraclePublicKey: identity.publicKey, broadcastResult: "fail" }),
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

    it("throws when getBobStatus throws", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ oraclePublicKey: identity.publicKey, tickResult: "fail" }),
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => relayToQubic(order, deps),
        /getBobStatus failed/,
      );
    });

    it("throws when queryContractFunction throws", async () => {
      const order = makeQubicOrder();

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ queryResult: "fail" }),
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

    it("skips signatures with invalid length", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const shortSig = Buffer.from(new Uint8Array(32)).toString("base64");

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: makeContractClient({ oraclePublicKey: identity.publicKey }),
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

    it("returns orderHash and targetTick for deferred confirmation", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const contractClient = {
        queryContractFunction: async () => buildOracleKeysHex(identity.publicKey),
        getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
        broadcastTransaction: async () => {},
      };

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient,
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollIntervalMs: 0,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await relayToQubic(order, deps);
      assert.ok(result.trxHash.length > 0);
      assert.strictEqual(result.targetTick, 105);
      assert.strictEqual(result.orderHash.length, 64);
    });

    it("uses the node tick provider for target tick when available", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder();
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async () => buildOracleKeysHex(identity.publicKey),
          getBobStatus: async () => ({ epoch: 1, tick: 206, fetchingTick: 206, indexingTick: 206 }),
          broadcastTransaction: async () => {},
        },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        getCurrentTick: async () => 200,
        pollIntervalMs: 0,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await relayToQubic(order, deps);
      assert.strictEqual(result.targetTick, 205);
    });
  });

  describe("finalizeQubicRelay", () => {
    it("does not fail early when fetching passes target before indexing catches up", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder({
        destination_trx_hash: "qubic-tx",
        destination_order_hash: "ab".repeat(32),
        destination_target_tick: 105,
        status: "transaction-broadcasted",
      });
      const sigBase64 = await signOrder(order);

      let bobCallCount = 0;
      let fillQueryCount = 0;
      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async (_funcNumber: number, input: string) => {
            if (input.length !== 64) return buildOracleKeysHex(identity.publicKey);
            fillQueryCount++;
            return fillQueryCount >= 2 ? "01" : "00";
          },
          getBobStatus: async () => {
            bobCallCount++;
            if (bobCallCount === 1) return { epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 };
            return { epoch: 1, tick: 106, fetchingTick: 106, indexingTick: 105 };
          },
          broadcastTransaction: async () => {},
        },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollIntervalMs: 0,
        pollMaxAttempts: 2,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await finalizeQubicRelay(order, deps);
      assert.strictEqual(result.trxHash, "qubic-tx");
      assert.strictEqual(result.orderHash, "ab".repeat(32));
    });

    it("exercises the poll sleep and throws timeout when Bob stalls (pollIntervalMs:1)", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder({
        destination_trx_hash: "qubic-tx",
        destination_order_hash: "cd".repeat(32),
        destination_target_tick: 105,
        status: "transaction-broadcasted",
      });
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async (_funcNumber: number, input: string) => {
            if (input.length === 64) return "00"; // never filled
            return buildOracleKeysHex(identity.publicKey);
          },
          getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }), // tick never advances past targetTick
          broadcastTransaction: async () => {},
        },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollIntervalMs: 1,
        pollMaxAttempts: 1,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => finalizeQubicRelay(order, deps),
        /timed out/,
      );
    });

    it("uses default pollIntervalMs when not set (pollMaxAttempts:0 causes instant timeout)", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder({
        destination_trx_hash: "qubic-tx",
        destination_order_hash: "ef".repeat(32),
        destination_target_tick: 105,
        status: "transaction-broadcasted",
      });
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async () => buildOracleKeysHex(identity.publicKey),
          getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
          broadcastTransaction: async () => {},
        },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollMaxAttempts: 0,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => finalizeQubicRelay(order, deps),
        /timed out after 0 attempts/,
      );
    });

    it("returns empty trxHash when destination_trx_hash is absent", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder({
        destination_trx_hash: undefined,
        destination_order_hash: "ab".repeat(32),
        destination_target_tick: 105,
        status: "transaction-broadcasted",
      });
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async (_funcNumber: number, input: string) => {
            if (input.length === 64) return "01"; // order is filled
            return buildOracleKeysHex(identity.publicKey);
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
        logger: noopLogger,
      };

      const result = await finalizeQubicRelay(order, deps);
      assert.strictEqual(result.trxHash, "");
    });

    it("throws QubicDefinitiveRelayFailure when target tick is passed without fill", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder({
        destination_trx_hash: "qubic-tx",
        destination_order_hash: "12".repeat(32),
        destination_target_tick: 105,
        status: "transaction-broadcasted",
      });
      const sigBase64 = await signOrder(order);

      let bobCallCount = 0;
      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async (_funcNumber: number, input: string) => {
            if (input.length === 64) return "00";
            return buildOracleKeysHex(identity.publicKey);
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
        logger: noopLogger,
      };

      await assert.rejects(
        () => finalizeQubicRelay(order, deps),
        (err) => err instanceof QubicDefinitiveRelayFailure,
      );
    });

    it("throws when destination_target_tick is missing", async () => {
      const order = makeQubicOrder({
        destination_trx_hash: "qubic-tx",
        destination_order_hash: "ab".repeat(32),
        destination_target_tick: undefined,
        status: "transaction-broadcasted",
      });

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async () => buildOracleKeysHex(),
          getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
          broadcastTransaction: async () => {},
        },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: new Uint8Array(32),
        pollIntervalMs: 0,
        ordersRepository: {
          findSignatures: async () => [],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => finalizeQubicRelay(order, deps),
        /Missing destination_target_tick/,
      );
    });

    it("computes order hash when destination_order_hash is absent", async () => {
      const identity = await loadQubicIdentity();
      const order = makeQubicOrder({
        destination_trx_hash: "qubic-tx",
        destination_order_hash: undefined,
        destination_target_tick: undefined,
        status: "transaction-broadcasted",
      });
      const sigBase64 = await signOrder(order);

      const deps: QubicRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        contractClient: {
          queryContractFunction: async () => buildOracleKeysHex(identity.publicKey),
          getBobStatus: async () => ({ epoch: 1, tick: 100, fetchingTick: 100, indexingTick: 100 }),
          broadcastTransaction: async () => {},
        },
        qubicSeed: QUBIC_FIXTURE_SEED,
        qubicPublicKey: identity.publicKey,
        pollIntervalMs: 0,
        ordersRepository: {
          findSignatures: async () => [sigBase64],
        } as unknown as QubicRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(
        () => finalizeQubicRelay(order, deps),
        /Missing destination_target_tick/,
      );
    });
  });

  describe("buildQubicRelayDeps", () => {
    it("returns deps with config, seed, publicKey, ordersRepository and contractClient", async (t) => {
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
      assert.ok(deps.contractClient, "contractClient should be set");
      assert.ok(deps.logger, "logger should be set");
    });

    it("reads the current tick from QUBIC_NODE_URL", async (t) => {
      const app = await build(t, { config: { RELAYER_ENABLED: false } });
      const mockOrdersRepository = {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"];

      const deps = await buildQubicRelayDeps(app, DEFAULT_TEST_CONFIG, mockOrdersRepository);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ tickInfo: { tick: 321 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      const tick = await deps.getCurrentTick?.();
      assert.strictEqual(tick, 321);
    });

    it("reads the current tick from the top-level tick field", async (t) => {
      const app = await build(t, { config: { RELAYER_ENABLED: false } });
      const mockOrdersRepository = {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"];

      const deps = await buildQubicRelayDeps(app, DEFAULT_TEST_CONFIG, mockOrdersRepository);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ tick: 654 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      const tick = await deps.getCurrentTick?.();
      assert.strictEqual(tick, 654);
    });

    it("throws when QUBIC_NODE_URL returns an invalid tick payload", async (t) => {
      const app = await build(t, { config: { RELAYER_ENABLED: false } });
      const mockOrdersRepository = {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"];

      const deps = await buildQubicRelayDeps(app, DEFAULT_TEST_CONFIG, mockOrdersRepository);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ nope: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      await assert.rejects(
        () => deps.getCurrentTick?.() ?? Promise.reject(new Error("missing getCurrentTick")),
        /tick-info: unexpected response/,
      );
    });

    it("throws when QUBIC_NODE_URL returns an HTTP error", async (t) => {
      const app = await build(t, { config: { RELAYER_ENABLED: false } });
      const mockOrdersRepository = {
        findSignatures: async () => [],
      } as unknown as QubicRelayDeps["ordersRepository"];

      const deps = await buildQubicRelayDeps(app, DEFAULT_TEST_CONFIG, mockOrdersRepository);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response("boom", {
          status: 503,
          headers: { "content-type": "text/plain" },
        })) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      await assert.rejects(
        () => deps.getCurrentTick?.() ?? Promise.reject(new Error("missing getCurrentTick")),
        /tick-info HTTP 503/,
      );
    });
  });
});
