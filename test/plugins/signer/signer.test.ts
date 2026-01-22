import { describe, it, TestContext } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
  getBytesEncoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
} from "@solana/kit";
import { signatureBytes, verifySignature } from "@solana/keys";

import envPlugin, {
  autoConfig as envAutoConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";
import validationPlugin from "../../../src/plugins/app/common/validation.js";
import signerService, {
  decodeSecretKey,
  normalizeSignatureValue,
  signSolanaOrderWithSigner,
  kSignerService,
  type SignerService,
} from "../../../src/plugins/app/signer/signer.service.js";

const fixturesDir = path.join(process.cwd(), "test/fixtures/signer");
const validSolanaKeys = path.join(fixturesDir, "solana.keys.json");
const validQubicKeys = path.join(fixturesDir, "qubic.keys.json");
const invalidStructureFile = path.join(fixturesDir, "invalid.keys.json");
const malformedFile = path.join(fixturesDir, "malformed.keys.json");
const missingFile = path.join(fixturesDir, "missing.keys.json");
const unreadablePath = path.join(fixturesDir, "directory.json");

const solanaFixtureKeys = {
  pKey: "BmeYyqDyr4T2ymByJGKVhTqGjeDYpWZj4Kf8x1a6Tre3",
  sKey: "LwdDrOVxJ1SKbEna9L/AWohEgpezYbuQ2DICTgRkEyegBOJkGYG01sq1bn8BnzQ34yxzQS7eMzulchLDYCPDyA==",
};

function bytes32(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeString(value: string): Uint8Array {
  const stringBytes = getUtf8Encoder().encode(value);
  const lengthBytes = getU32Encoder().encode(stringBytes.length);
  return concatBytes([new Uint8Array(lengthBytes), new Uint8Array(stringBytes)]);
}

type SignerEnvOverrides = Partial<{
  SOLANA_KEYS: string;
  QUBIC_KEYS: string;
  HUB_KEYS_FILE: string;
}>;

async function buildSignerApp(overrides: SignerEnvOverrides = {}) {
  const app = fastify();
  const envOptions = {
    ...envAutoConfig,
    dotenv: false,
    data: {
      ...process.env,
      SOLANA_KEYS: overrides.SOLANA_KEYS ?? validSolanaKeys,
      QUBIC_KEYS: overrides.QUBIC_KEYS ?? validQubicKeys,
      HUB_KEYS_FILE:
        overrides.HUB_KEYS_FILE ??
        path.join(process.cwd(), "test/fixtures/hub-keys.json"),
      HUB_URLS: "http://127.0.0.1:3010,http://127.0.0.1:3011",
      SOLANA_WS_URL: "ws://localhost:8900",
      SOLANA_LISTENER_ENABLED: false,
      SOLANA_BPS_FEE: 25,
      RELAYER_FEE_PERCENT: "0.1",
    },
  };

  try {
    await app.register(fmPlugin);
    await app.register(validationPlugin);
    await app.register(envPlugin, envOptions);
    await app.register(signerService);
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

async function createTempSolanaKeysFile(payload: {
  pKey: string;
  sKey: string;
}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-signer-"));
  const filePath = path.join(tempDir, "solana.keys.json");
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

describe("signerService", () => {
  it("rejects when SOLANA_KEYS is not a JSON file", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: "./keys.txt" }),
      /SOLANA_KEYS must point to a JSON file/
    );
  });

  it("rejects when QUBIC_KEYS contains traversal sequences", async () => {
    await assert.rejects(
      buildSignerApp({ QUBIC_KEYS: "../test/fixtures/signer/qubic.keys.json" }),
      /QUBIC_KEYS must not contain parent directory traversal/
    );
  });

  it("rejects when a keys file cannot be parsed as JSON", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: malformedFile }),
      /SignerService\(SOLANA_KEYS\): file does not contain valid JSON/
    );
  });

  it("rejects when a keys file does not match the schema", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: invalidStructureFile }),
      /SignerService\(SOLANA_KEYS\): invalid schema/
    );
  });

  it("rejects when a keys file is missing", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: missingFile }),
      /SignerService\(SOLANA_KEYS\): file not found/
    );
  });

  it("rejects when a keys file cannot be read", async () => {
    await assert.rejects(
      buildSignerApp({ SOLANA_KEYS: unreadablePath }),
      /SignerService\(SOLANA_KEYS\): unable to read file/
    );
  });

  it("decorates signerService when inputs are valid", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());
    const signer: SignerService = app.getDecorator(kSignerService);

    assert.strictEqual(typeof signer.signSolanaOrder, "function");
  });

  it("signs a solana order using the fixture keypair", async (t: TestContext) => {
    const app = await buildSignerApp();
    t.after(() => app.close());
    const signer: SignerService = app.getDecorator(kSignerService);

    const order = {
      protocolName: "qs-bridge",
      protocolVersion: "1",
      contractAddress: bytes32(1),
      networkIn: 1,
      networkOut: 2,
      tokenIn: bytes32(2),
      tokenOut: bytes32(3),
      fromAddress: bytes32(4),
      toAddress: bytes32(5),
      amount: 1n,
      relayerFee: 0n,
      bpsFee: 25,
      nonce: bytes32(6),
    };

    const signature = await signer.signSolanaOrder(order);

    const encoded = concatBytes([
      encodeString(order.protocolName),
      encodeString(order.protocolVersion),
      new Uint8Array(getBytesEncoder().encode(order.contractAddress)),
      new Uint8Array(getU32Encoder().encode(order.networkIn)),
      new Uint8Array(getU32Encoder().encode(order.networkOut)),
      new Uint8Array(getBytesEncoder().encode(order.tokenIn)),
      new Uint8Array(getBytesEncoder().encode(order.tokenOut)),
      new Uint8Array(getBytesEncoder().encode(order.fromAddress)),
      new Uint8Array(getBytesEncoder().encode(order.toAddress)),
      new Uint8Array(getU64Encoder().encode(order.amount)),
      new Uint8Array(getU64Encoder().encode(order.relayerFee)),
      new Uint8Array(getU16Encoder().encode(order.bpsFee)),
      new Uint8Array(getBytesEncoder().encode(order.nonce)),
    ]);
    const digest = createHash("sha256").update(encoded).digest();
    const message = createSignableMessage(digest);
    const sigBytes = signatureBytes(Buffer.from(signature, "base64"));
    const keypairSigner = await createKeyPairSignerFromBytes(
      new Uint8Array(Buffer.from(solanaFixtureKeys.sKey, "base64"))
    );

    const ok = await verifySignature(
      keypairSigner.keyPair.publicKey,
      sigBytes,
      message.content
    );
    t.assert.ok(ok);
  });

  it("signs a solana order with numeric fields provided as strings", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());
    const signer: SignerService = app.getDecorator(kSignerService);

    const signature = await signer.signSolanaOrder({
      protocolName: "qs-bridge",
      protocolVersion: "1",
      contractAddress: bytes32(10),
      networkIn: "1",
      networkOut: "2",
      tokenIn: bytes32(11),
      tokenOut: bytes32(12),
      fromAddress: bytes32(13),
      toAddress: bytes32(14),
      amount: "1",
      relayerFee: "0",
      bpsFee: "25",
      nonce: bytes32(15),
    });

    assert.ok(Buffer.from(signature, "base64").length > 0);
  });

  it("signs a solana order with numeric fields provided as numbers", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());
    const signer: SignerService = app.getDecorator(kSignerService);

    const signature = await signer.signSolanaOrder({
      protocolName: "qs-bridge",
      protocolVersion: "1",
      contractAddress: bytes32(20),
      networkIn: 1,
      networkOut: 2,
      tokenIn: bytes32(21),
      tokenOut: bytes32(22),
      fromAddress: bytes32(23),
      toAddress: bytes32(24),
      amount: 1,
      relayerFee: 0,
      bpsFee: 25,
      nonce: bytes32(25),
    });

    assert.ok(Buffer.from(signature, "base64").length > 0);
  });

  it("rejects solana orders with invalid numeric fields", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());
    const signer: SignerService = app.getDecorator(kSignerService);

    const baseOrder = {
      protocolName: "qs-bridge",
      protocolVersion: "1",
      contractAddress: bytes32(30),
      networkIn: 1,
      networkOut: 2,
      tokenIn: bytes32(31),
      tokenOut: bytes32(32),
      fromAddress: bytes32(33),
      toAddress: bytes32(34),
      amount: 1n,
      relayerFee: 0n,
      bpsFee: 25,
      nonce: bytes32(35),
    };

    await assert.rejects(
      signer.signSolanaOrder({
        ...baseOrder,
        networkIn: 4294967296,
      }),
      /networkIn must be uint32/
    );

    await assert.rejects(
      signer.signSolanaOrder({
        ...baseOrder,
        amount: -1n,
      }),
      /amount must be uint64/
    );

    await assert.rejects(
      signer.signSolanaOrder({
        ...baseOrder,
        bpsFee: 70000,
      }),
      /bpsFee must be uint16/
    );
  });

  it("rejects solana orders with invalid byte lengths", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());
    const signer: SignerService = app.getDecorator(kSignerService);

    await assert.rejects(
      signer.signSolanaOrder({
        protocolName: "qs-bridge",
        protocolVersion: "1",
        contractAddress: bytes32(1),
        networkIn: 1,
        networkOut: 2,
        tokenIn: new Uint8Array(31),
        tokenOut: bytes32(3),
        fromAddress: bytes32(4),
        toAddress: bytes32(5),
        amount: 1n,
        relayerFee: 0n,
        bpsFee: 25,
        nonce: bytes32(6),
      }),
      /tokenIn must be 32 bytes/
    );
  });

  it("rejects invalid solana secret key lengths", async (t) => {
    const solanaKeysFile = await createTempSolanaKeysFile({
      pKey: solanaFixtureKeys.pKey,
      sKey: Buffer.from("short").toString("base64"),
    });
    const app = await buildSignerApp({ SOLANA_KEYS: solanaKeysFile });
    t.after(async () => {
      await app.close();
      await fs.rm(path.dirname(solanaKeysFile), {
        recursive: true,
        force: true,
      });
    });
    const signer: SignerService = app.getDecorator(kSignerService);

    await assert.rejects(
      signer.signSolanaOrder({
        protocolName: "qs-bridge",
        protocolVersion: "1",
        contractAddress: bytes32(40),
        networkIn: 1,
        networkOut: 2,
        tokenIn: bytes32(41),
        tokenOut: bytes32(42),
        fromAddress: bytes32(43),
        toAddress: bytes32(44),
        amount: 1n,
        relayerFee: 0n,
        bpsFee: 25,
        nonce: bytes32(45),
      }),
      /secret key must be 64 bytes/
    );
  });

  it("rejects solana keys when the public key does not match", async (t) => {
    const solanaKeysFile = await createTempSolanaKeysFile({
      pKey: "Mismatch",
      sKey: solanaFixtureKeys.sKey,
    });
    const app = await buildSignerApp({ SOLANA_KEYS: solanaKeysFile });
    t.after(async () => {
      await app.close();
      await fs.rm(path.dirname(solanaKeysFile), {
        recursive: true,
        force: true,
      });
    });
    const signer: SignerService = app.getDecorator(kSignerService);

    await assert.rejects(
      signer.signSolanaOrder({
        protocolName: "qs-bridge",
        protocolVersion: "1",
        contractAddress: bytes32(50),
        networkIn: 1,
        networkOut: 2,
        tokenIn: bytes32(51),
        tokenOut: bytes32(52),
        fromAddress: bytes32(53),
        toAddress: bytes32(54),
        amount: 1n,
        relayerFee: 0n,
        bpsFee: 25,
        nonce: bytes32(55),
      }),
      /public key does not match secret key/
    );
  });

  it("exposes helper behavior for signature normalization and error paths", async () => {
    assert.strictEqual(normalizeSignatureValue("Zg=="), "Zg==");

    assert.throws(
      () => decodeSecretKey("not-base64"),
      /secret key must be 64 bytes/
    );

    assert.throws(
      () => normalizeSignatureValue(123),
      /unsupported signature format/
    );

    await assert.rejects(
      signSolanaOrderWithSigner(
        {
          protocolName: "qs-bridge",
          protocolVersion: "1",
          contractAddress: bytes32(60),
          networkIn: 1,
          networkOut: 2,
          tokenIn: bytes32(61),
          tokenOut: bytes32(62),
          fromAddress: bytes32(63),
          toAddress: bytes32(64),
          amount: 1n,
          relayerFee: 0n,
          bpsFee: 25,
          nonce: bytes32(65),
        },
        {
          address: "missing",
          signMessages: async () => [{}],
        }
      ),
      /signer did not return a signature/
    );
  });
});
