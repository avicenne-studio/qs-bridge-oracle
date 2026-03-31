import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  type Address,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getAddressDecoder,
} from "@solana/kit";
import {
  verifyEd25519,
  matchSignaturesToOracles,
  fetchOracleAddresses,
  estimatePriorityFee,
  relayToSolana,
  type SolanaRelayDeps,
} from "../../../src/plugins/app/relayer/relay-solana.js";
import { getOracleSize } from "../../../src/clients/js/accounts/oracle.js";
import { hexToBytes, bytesToHex, decodeSecretKey } from "../../../src/plugins/app/common/bytes.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../../../src/plugins/app/common/protocol.js";
import { QUBIC_TOKEN_ADDRESS } from "../../../src/plugins/app/common/qubic/encoding.js";
import {
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
} from "../../../src/plugins/app/common/solana/program.js";
import { Network } from "../../../src/plugins/app/common/schemas/common.js";
import type { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";
import { DEFAULT_TEST_CONFIG } from "../../helpers/build.js";

function makeEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return { publicKey, privateKey, pubRaw };
}

function ed25519Sign(message: Uint8Array, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  return new Uint8Array(sign(null, message, privateKey as import("node:crypto").KeyObject));
}

const addressEnc = getAddressEncoder();
const addressDec = getAddressDecoder();

function makeOracleAccountData(pubRaw: Uint8Array) {
  const data = Buffer.alloc(getOracleSize());
  data[0] = 1; // Key.Oracle
  data.set(pubRaw, 1);
  return data;
}

function oracleAddress(pubRaw: Uint8Array): Address {
  return addressDec.decode(pubRaw);
}

function rpcOracleAccounts(entries: { pubRaw: Uint8Array }[]) {
  return {
    send: async () =>
      entries.map(({ pubRaw }) => ({
        pubkey: oracleAddress(pubRaw),
        account: {
          data: [Buffer.from(makeOracleAccountData(pubRaw)).toString("base64"), "base64"] as [string, string],
          executable: false,
          lamports: 0n,
          owner: "" as Address,
          space: BigInt(getOracleSize()),
        },
      })),
  };
}

const noopLogger = { info() {}, error() {} } as unknown as SolanaRelayDeps["logger"];

async function loadRelayerSigner() {
  const fs = await import("node:fs");
  const keys = JSON.parse(fs.readFileSync(DEFAULT_TEST_CONFIG.SOLANA_KEYS, "utf-8"));
  return createKeyPairSignerFromBytes(decodeSecretKey(keys.sKey));
}

function makeSolanaOrder(overrides: Partial<OracleOrder> = {}): OracleOrder {
  const fromHex = bytesToHex(new Uint8Array(32).fill(1));
  const kp = makeEd25519Keypair();
  const toHex = bytesToHex(kp.pubRaw);
  const nonceHex = bytesToHex(new Uint8Array(32).fill(9));
  return {
    id: "00000000-0000-4000-8000-000000000099",
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
    ...overrides,
  };
}

describe("relay-solana helpers", () => {
  describe("verifyEd25519", () => {
    it("returns true for a valid signature", async () => {
      const { pubRaw, privateKey } = makeEd25519Keypair();
      const message = createHash("sha256").update("test-message").digest();
      const sig = ed25519Sign(message, privateKey);
      assert.strictEqual(await verifyEd25519(message, sig, pubRaw), true);
    });

    it("returns false for an invalid signature", async () => {
      const { pubRaw } = makeEd25519Keypair();
      const message = createHash("sha256").update("test-message").digest();
      assert.strictEqual(await verifyEd25519(message, new Uint8Array(64), pubRaw), false);
    });
  });

  describe("matchSignaturesToOracles", () => {
    it("matches a valid signature to its oracle", async () => {
      const kp = makeEd25519Keypair();
      const digest = createHash("sha256").update("order-data").digest();
      const sig = ed25519Sign(digest, kp.privateKey);
      const oracle = oracleAddress(kp.pubRaw);

      const { matched } = await matchSignaturesToOracles([sig], [oracle], new Uint8Array(digest));
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].oracle, oracle);
    });

    it("does not reuse an oracle for duplicate signatures", async () => {
      const kp = makeEd25519Keypair();
      const digest = createHash("sha256").update("order-data").digest();
      const sig = ed25519Sign(digest, kp.privateKey);
      const oracle = oracleAddress(kp.pubRaw);

      const { matched } = await matchSignaturesToOracles([sig, sig], [oracle], new Uint8Array(digest));
      assert.strictEqual(matched.length, 1);
    });
  });

  describe("fetchOracleAddresses", () => {
    it("parses oracle pubkeys from account data", async () => {
      const kp = makeEd25519Keypair();
      const rpc = {
        getProgramAccounts: () => rpcOracleAccounts([{ pubRaw: kp.pubRaw }]),
      } as unknown as SolanaRelayDeps["rpc"];

      const addresses = await fetchOracleAddresses(rpc);
      assert.strictEqual(addresses.length, 1);
      assert.strictEqual(addresses[0], oracleAddress(kp.pubRaw));
    });

    it("returns empty when no accounts found", async () => {
      const rpc = {
        getProgramAccounts: () => rpcOracleAccounts([]),
      } as unknown as SolanaRelayDeps["rpc"];
      assert.deepStrictEqual(await fetchOracleAddresses(rpc), []);
    });
  });

  describe("estimatePriorityFee", () => {
    function mockRpc(fees: { slot: bigint; prioritizationFee: bigint }[]) {
      return {
        getRecentPrioritizationFees: () => ({ send: async () => fees }),
      } as unknown as SolanaRelayDeps["rpc"];
    }

    it("returns 0 when no recent fees exist", async () => {
      const fee = await estimatePriorityFee(mockRpc([]), [], 1_000_000);
      assert.strictEqual(fee, 0n);
    });

    it("returns 0 when all fees are zero", async () => {
      const fee = await estimatePriorityFee(mockRpc([
        { slot: 1n, prioritizationFee: 0n },
        { slot: 2n, prioritizationFee: 0n },
      ]), [], 1_000_000);
      assert.strictEqual(fee, 0n);
    });

    it("returns the median of non-zero fees", async () => {
      const fee = await estimatePriorityFee(mockRpc([
        { slot: 1n, prioritizationFee: 100n },
        { slot: 2n, prioritizationFee: 200n },
        { slot: 3n, prioritizationFee: 500n },
        { slot: 4n, prioritizationFee: 0n },
      ]), [], 1_000_000);
      assert.strictEqual(fee, 200n);
    });

    it("caps at maxFee", async () => {
      const fee = await estimatePriorityFee(mockRpc([
        { slot: 1n, prioritizationFee: 5_000_000n },
        { slot: 2n, prioritizationFee: 10_000_000n },
      ]), [], 1_000_000);
      assert.strictEqual(fee, 1_000_000n);
    });
  });

  describe("relayToSolana", () => {
    it("throws when no signatures are stored", async () => {
      const order = makeSolanaOrder();
      const relayerSigner = await loadRelayerSigner();
      const deps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        rpc: {} as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => [] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
        getLookupTable: async () => ({}),
        getOracleAddresses: async () => [],
      };

      await assert.rejects(() => relayToSolana(order, deps), { message: "No oracle signatures found for order" });
    });

    it("throws when no oracles are found on chain", async () => {
      const order = makeSolanaOrder();
      const relayerSigner = await loadRelayerSigner();
      const deps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        rpc: {} as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => ["AAAA"] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
        getLookupTable: async () => ({}),
        getOracleAddresses: async () => [],
      };

      await assert.rejects(() => relayToSolana(order, deps), { message: "No registered oracles found on chain" });
    });

    it("throws when no signatures match any oracle", async () => {
      const unrelated = makeEd25519Keypair();
      const order = makeSolanaOrder();
      const relayerSigner = await loadRelayerSigner();
      const deps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        rpc: {} as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: {
          findSignatures: async () => [Buffer.from(new Uint8Array(64)).toString("base64")],
        } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
        getLookupTable: async () => ({}),
        getOracleAddresses: async () => [oracleAddress(unrelated.pubRaw)],
      };

      await assert.rejects(() => relayToSolana(order, deps), { message: "No signatures could be matched to registered oracles" });
    });

    it("builds, signs and sends a transaction when signatures match", async () => {
      const oracle = makeEd25519Keypair();
      const relayerSigner = await loadRelayerSigner();

      const toHex = bytesToHex(oracle.pubRaw);
      const fromHex = bytesToHex(new Uint8Array(32).fill(1));
      const nonceHex = bytesToHex(new Uint8Array(32).fill(9));
      const order = makeSolanaOrder({ from: fromHex, to: toHex, source_nonce: nonceHex });

      const tokenMintBytes = new Uint8Array(addressEnc.encode(DEFAULT_TEST_CONFIG.TOKEN_MINT as Address));
      const digest = createHash("sha256").update(serializeBridgeOrder({
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
      })).digest();
      const sigBase64 = Buffer.from(ed25519Sign(digest, oracle.privateKey)).toString("base64");

      let sendCalled = false;
      const deps: SolanaRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        rpc: {
          getLatestBlockhash: () => ({
            send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999n } }),
          }),
          getRecentPrioritizationFees: () => ({ send: async () => [] }),
        } as unknown as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => { sendCalled = true; }) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => [sigBase64] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
        getLookupTable: async () => ({}),
        getOracleAddresses: async () => [oracleAddress(oracle.pubRaw)],
      };

      const result = await relayToSolana(order, deps);
      assert.ok(result.trxHash.length > 0);
      assert.ok(sendCalled);
    });
  });
});
