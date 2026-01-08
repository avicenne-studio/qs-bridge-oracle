import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { serialize } from "borsh";
import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
} from "@solana/kit";
import { signatureBytes, verifySignature } from "@solana/keys";

import envPlugin, {
  autoConfig as envAutoConfig,
} from "../../../src/plugins/infra/env.js";
import fmPlugin from "../../../src/plugins/infra/@file-manager.js";
import validationPlugin from "../../../src/plugins/infra/validation.js";
import signerService, {
  __test__ as signerTestHelpers,
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

  it("decorates signerService with both key sets when inputs are valid", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());

    assert.deepStrictEqual(app.signerService.solana, {
      pKey: solanaFixtureKeys.pKey,
      sKey: solanaFixtureKeys.sKey,
    });
    assert.deepStrictEqual(app.signerService.qubic, {
      pKey: "QUBIC_PUBLIC_KEY",
      sKey: "QUBIC_SECRET_KEY",
    });
  });

  it("signs a solana order using the fixture keypair", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());

    const order = {
      protocolName: "qs-bridge",
      protocolVersion: 1,
      destinationChainId: 2,
      contractAddress: "So11111111111111111111111111111111111111112",
      networkIn: "solana",
      networkOut: "qubic",
      tokenIn: "So11111111111111111111111111111111111111112",
      tokenOut: "QUBIC",
      fromAddress: "from",
      toAddress: "to",
      amount: 1n,
      relayerFee: 0n,
      nonce: 1n,
    };

    const signature = await app.signerService.signSolanaOrder(order);
    assert.match(signature, /^[A-Za-z0-9+/=]+$/);

    const schema = {
      struct: {
        protocolName: "string",
        protocolVersion: "u32",
        destinationChainId: "u32",
        contractAddress: "string",
        networkIn: "string",
        networkOut: "string",
        tokenIn: "string",
        tokenOut: "string",
        fromAddress: "string",
        toAddress: "string",
        amount: "u64",
        relayerFee: "u64",
        nonce: "u64",
      },
    } as const;

    const serialized = serialize(schema, order);
    const digest = createHash("sha256").update(serialized).digest();
    const message = createSignableMessage(digest);
    const sigBytes = signatureBytes(Buffer.from(signature, "base64"));
    const signer = await createKeyPairSignerFromBytes(
      new Uint8Array(Buffer.from(solanaFixtureKeys.sKey, "base64"))
    );

    const ok = await verifySignature(
      signer.keyPair.publicKey,
      sigBytes,
      message.content
    );
    assert.ok(ok);
  });

  it("signs a solana order with numeric fields provided as strings", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());

    const signature = await app.signerService.signSolanaOrder({
      protocolName: "qs-bridge",
      protocolVersion: "1",
      destinationChainId: "2",
      contractAddress: "So11111111111111111111111111111111111111112",
      networkIn: "solana",
      networkOut: "qubic",
      tokenIn: "So11111111111111111111111111111111111111112",
      tokenOut: "QUBIC",
      fromAddress: "from",
      toAddress: "to",
      amount: "1",
      relayerFee: "0",
      nonce: "1",
    });

    assert.ok(Buffer.from(signature, "base64").length > 0);
  });

  it("signs a solana order with numeric fields provided as numbers", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());

    const signature = await app.signerService.signSolanaOrder({
      protocolName: "qs-bridge",
      protocolVersion: 1,
      destinationChainId: 2,
      contractAddress: "So11111111111111111111111111111111111111112",
      networkIn: "solana",
      networkOut: "qubic",
      tokenIn: "So11111111111111111111111111111111111111112",
      tokenOut: "QUBIC",
      fromAddress: "from",
      toAddress: "to",
      amount: 1,
      relayerFee: 0,
      nonce: 1,
    });

    assert.ok(Buffer.from(signature, "base64").length > 0);
  });

  it("rejects solana orders with invalid numeric fields", async (t) => {
    const app = await buildSignerApp();
    t.after(() => app.close());

    const baseOrder = {
      protocolName: "qs-bridge",
      protocolVersion: 1,
      destinationChainId: 2,
      contractAddress: "So11111111111111111111111111111111111111112",
      networkIn: "solana",
      networkOut: "qubic",
      tokenIn: "So11111111111111111111111111111111111111112",
      tokenOut: "QUBIC",
      fromAddress: "from",
      toAddress: "to",
      amount: 1n,
      relayerFee: 0n,
      nonce: 1n,
    };

    await assert.rejects(
      app.signerService.signSolanaOrder({
        ...baseOrder,
        protocolVersion: 4294967296,
      }),
      /protocolVersion must be uint32/
    );

    await assert.rejects(
      app.signerService.signSolanaOrder({
        ...baseOrder,
        amount: -1n,
      }),
      /amount must be uint64/
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

    await assert.rejects(
      app.signerService.signSolanaOrder({
        protocolName: "qs-bridge",
        protocolVersion: 1,
        destinationChainId: 2,
        contractAddress: "So11111111111111111111111111111111111111112",
        networkIn: "solana",
        networkOut: "qubic",
        tokenIn: "So11111111111111111111111111111111111111112",
        tokenOut: "QUBIC",
        fromAddress: "from",
        toAddress: "to",
        amount: 1n,
        relayerFee: 0n,
        nonce: 1n,
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

    await assert.rejects(
      app.signerService.signSolanaOrder({
        protocolName: "qs-bridge",
        protocolVersion: 1,
        destinationChainId: 2,
        contractAddress: "So11111111111111111111111111111111111111112",
        networkIn: "solana",
        networkOut: "qubic",
        tokenIn: "So11111111111111111111111111111111111111112",
        tokenOut: "QUBIC",
        fromAddress: "from",
        toAddress: "to",
        amount: 1n,
        relayerFee: 0n,
        nonce: 1n,
      }),
      /public key does not match secret key/
    );
  });

  it("exposes helper behavior for signature normalization and error paths", async () => {
    assert.strictEqual(
      signerTestHelpers.normalizeSignatureValue("Zg=="),
      "Zg=="
    );

    assert.throws(
      () => signerTestHelpers.decodeSecretKey("not-base64"),
      /secret key must be 64 bytes/
    );

    assert.throws(
      () => signerTestHelpers.normalizeSignatureValue(123),
      /unsupported signature format/
    );

    await assert.rejects(
      signerTestHelpers.signSolanaOrderWithSigner(
        {
          protocolName: "qs-bridge",
          protocolVersion: 1,
          destinationChainId: 2,
          contractAddress: "So11111111111111111111111111111111111111112",
          networkIn: "solana",
          networkOut: "qubic",
          tokenIn: "So11111111111111111111111111111111111111112",
          tokenOut: "QUBIC",
          fromAddress: "from",
          toAddress: "to",
          amount: 1n,
          relayerFee: 0n,
          nonce: 1n,
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
