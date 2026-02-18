import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  type Address,
  createKeyPairSignerFromBytes,
} from "@solana/kit";
import { PublicKey, Connection } from "@solana/web3.js";
import {
  verifyEd25519,
  matchSignaturesToOracles,
  fetchOracleAddresses,
  relayToSolana,
  type SolanaRelayDeps,
} from "../../../src/plugins/app/relayer/relay-solana.js";
import { getOracleSize } from "../../../src/clients/js/accounts/oracle.js";
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
import { DEFAULT_TEST_CONFIG } from "../../helpers/build.js";

function makeEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return { publicKey, privateKey, pubRaw };
}

function ed25519Sign(message: Uint8Array, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  return new Uint8Array(sign(null, message, privateKey as import("node:crypto").KeyObject));
}

function makeOracleAccountData(pubRaw: Uint8Array) {
  const data = Buffer.alloc(getOracleSize());
  data[0] = 2;
  data.set(pubRaw, 1);
  return data;
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
  const toHex = bytesToHex(new PublicKey(kp.pubRaw).toBytes());
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
    ...overrides,
  };
}

describe("relay-solana helpers", () => {
  describe("verifyEd25519", () => {
    it("returns true for a valid signature", () => {
      const { pubRaw, privateKey } = makeEd25519Keypair();
      const message = createHash("sha256").update("test-message").digest();
      const sig = ed25519Sign(message, privateKey);
      assert.strictEqual(verifyEd25519(message, sig, pubRaw), true);
    });

    it("returns false for an invalid signature", () => {
      const { pubRaw } = makeEd25519Keypair();
      const message = createHash("sha256").update("test-message").digest();
      assert.strictEqual(verifyEd25519(message, new Uint8Array(64), pubRaw), false);
    });
  });

  describe("matchSignaturesToOracles", () => {
    it("matches a valid signature to its oracle", () => {
      const kp = makeEd25519Keypair();
      const digest = createHash("sha256").update("order-data").digest();
      const sig = ed25519Sign(digest, kp.privateKey);
      const oracle = new PublicKey(kp.pubRaw).toBase58() as Address;

      const { matched } = matchSignaturesToOracles([sig], [oracle], new Uint8Array(digest));
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].oracle, oracle);
    });

    it("does not reuse an oracle for duplicate signatures", () => {
      const kp = makeEd25519Keypair();
      const digest = createHash("sha256").update("order-data").digest();
      const sig = ed25519Sign(digest, kp.privateKey);
      const oracle = new PublicKey(kp.pubRaw).toBase58() as Address;

      const { matched } = matchSignaturesToOracles([sig, sig], [oracle], new Uint8Array(digest));
      assert.strictEqual(matched.length, 1);
    });
  });

  describe("fetchOracleAddresses", () => {
    it("parses oracle pubkeys from account data", async () => {
      const kp = makeEd25519Keypair();
      const conn = {
        getProgramAccounts: async () => [
          { pubkey: new PublicKey(kp.pubRaw), account: { data: makeOracleAccountData(kp.pubRaw) } },
        ],
      } as unknown as Connection;

      const addresses = await fetchOracleAddresses(conn);
      assert.strictEqual(addresses.length, 1);
      assert.strictEqual(addresses[0], new PublicKey(kp.pubRaw).toBase58());
    });

    it("returns empty when no accounts found", async () => {
      const conn = { getProgramAccounts: async () => [] } as unknown as Connection;
      assert.deepStrictEqual(await fetchOracleAddresses(conn), []);
    });
  });

  describe("relayToSolana", () => {
    it("throws when no signatures are stored", async () => {
      const order = makeSolanaOrder();
      const relayerSigner = await loadRelayerSigner();
      const deps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        connection: {} as Connection,
        rpc: {} as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => [] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(() => relayToSolana(order, deps), { message: "No oracle signatures found for order" });
    });

    it("throws when no oracles are found on chain", async () => {
      const order = makeSolanaOrder();
      const relayerSigner = await loadRelayerSigner();
      const deps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        connection: { getProgramAccounts: async () => [] } as unknown as Connection,
        rpc: {} as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => ["AAAA"] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
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
        connection: {
          getProgramAccounts: async () => [
            { pubkey: new PublicKey(unrelated.pubRaw), account: { data: makeOracleAccountData(unrelated.pubRaw) } },
          ],
        } as unknown as Connection,
        rpc: {} as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => undefined) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: {
          findSignatures: async () => [Buffer.from(new Uint8Array(64)).toString("base64")],
        } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      await assert.rejects(() => relayToSolana(order, deps), { message: "No signatures could be matched to registered oracles" });
    });

    it("builds, signs and sends a transaction when signatures match", async () => {
      const oracle = makeEd25519Keypair();
      const relayerSigner = await loadRelayerSigner();

      const toHex = bytesToHex(new PublicKey(oracle.pubRaw).toBytes());
      const fromHex = bytesToHex(new Uint8Array(32).fill(1));
      const nonceHex = bytesToHex(new Uint8Array(32).fill(9));
      const order = makeSolanaOrder({ from: fromHex, to: toHex, source_nonce: nonceHex });

      const tokenMintBytes = new PublicKey(DEFAULT_TEST_CONFIG.TOKEN_MINT).toBytes();
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
        amount: 1000n,
        relayerFee: 10n,
        nonce: hexToBytes(nonceHex),
      })).digest();
      const sigBase64 = Buffer.from(ed25519Sign(digest, oracle.privateKey)).toString("base64");

      let sendCalled = false;
      const deps: SolanaRelayDeps = {
        config: DEFAULT_TEST_CONFIG,
        relayerSigner,
        connection: {
          getProgramAccounts: async () => [
            { pubkey: new PublicKey(oracle.pubRaw), account: { data: makeOracleAccountData(oracle.pubRaw) } },
          ],
        } as unknown as Connection,
        rpc: {
          getLatestBlockhash: () => ({
            send: async () => ({ value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999n } }),
          }),
        } as unknown as SolanaRelayDeps["rpc"],
        sendAndConfirm: (async () => { sendCalled = true; }) as unknown as SolanaRelayDeps["sendAndConfirm"],
        ordersRepository: { findSignatures: async () => [sigBase64] } as unknown as SolanaRelayDeps["ordersRepository"],
        logger: noopLogger,
      };

      const result = await relayToSolana(order, deps);
      assert.ok(result.trxHash.length > 0);
      assert.ok(sendCalled);
    });
  });
});
