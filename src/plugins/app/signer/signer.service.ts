import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { createKeyPairSignerFromBytes, createSignableMessage } from "@solana/kit";
import qubicCrypto from "@qubic-lib/qubic-ts-library";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { SignerKeys, SignerKeysSchema } from "./schemas/keys.js";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import { kFileManager, type FileManager } from "../../infra/@file-manager.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import { decodeSecretKey, normalizeSignatureValue, assertFixedBytes } from "../common/bytes.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../common/protocol.js";
import {
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
} from "../common/solana/program.js";
import { QUBIC_CONTRACT_ADDRESS_BYTES } from "../common/qubic/encoding.js";

export type OrderInput = {
  networkIn: number;
  networkOut: number;
  tokenIn: Uint8Array;
  tokenOut: Uint8Array;
  fromAddress: Uint8Array;
  toAddress: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  nonce: Uint8Array;
  orderEra: number;
};

export type SignerService = {
  signLockOrderForSolana: (order: OrderInput) => Promise<string>;
  signUnlockOrderForQubic: (order: OrderInput) => Promise<string>;
};

export const kSignerService = Symbol("app.signerService");

function serializeOrderForSolana(order: OrderInput): Uint8Array {
  assertFixedBytes(order.tokenIn, "tokenIn", 32);
  assertFixedBytes(order.tokenOut, "tokenOut", 32);
  assertFixedBytes(order.fromAddress, "fromAddress", 32);
  assertFixedBytes(order.toAddress, "toAddress", 32);
  assertFixedBytes(order.nonce, "nonce", 32);
  return serializeBridgeOrder({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: CONTRACT_ADDRESS_BYTES,
    networkIn: order.networkIn,
    networkOut: order.networkOut,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    fromAddress: order.fromAddress,
    toAddress: order.toAddress,
    amount: order.amount,
    relayerFee: order.relayerFee,
    nonce: order.nonce,
    orderEra: order.orderEra,
  });
}

function serializeOrderForQubic(order: OrderInput): Uint8Array {
  assertFixedBytes(order.tokenIn, "tokenIn", 32);
  assertFixedBytes(order.tokenOut, "tokenOut", 32);
  assertFixedBytes(order.fromAddress, "fromAddress", 32);
  assertFixedBytes(order.toAddress, "toAddress", 32);
  assertFixedBytes(order.nonce, "nonce", 32);
  return serializeBridgeOrder({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
    networkIn: order.networkIn,
    networkOut: order.networkOut,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    fromAddress: order.fromAddress,
    toAddress: order.toAddress,
    amount: order.amount,
    relayerFee: order.relayerFee,
    nonce: order.nonce,
    orderEra: order.orderEra,
  });
}

type SolanaSigner = {
  address: string;
  signMessages: (
    messages: ReturnType<typeof createSignableMessage>[],
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
};

type QubicSigner = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  sign: (serialized: Uint8Array) => string;
};

type QubicCrypto = {
  schnorrq: {
    sign: (sk: Uint8Array, pk: Uint8Array, msg: Uint8Array) => Uint8Array;
  };
  K12: (input: Uint8Array, output: Uint8Array, outputLength: number) => void;
};

// The WASM module exposes the crypto API behind `.default.crypto` (a Promise).
// The ESM interop wraps the CJS export, so we must unwrap it manually.
const resolvedQubicCrypto = (qubicCrypto as unknown as { default: { crypto: Promise<QubicCrypto> } }).default.crypto;
const QUBIC_DIGEST_LENGTH = 32;

async function createSolanaSignerFromKeys(keys: SignerKeys): Promise<SolanaSigner> {
  const secretKeyBytes = decodeSecretKey(keys.sKey);
  const signer = await createKeyPairSignerFromBytes(secretKeyBytes);
  if (keys.pKey && signer.address !== keys.pKey) {
    throw new Error("SignerService(SOLANA_KEYS): public key does not match secret key");
  }
  return signer;
}

async function createQubicSignerFromKeys(keys: SignerKeys): Promise<QubicSigner> {
  const helper = new QubicHelper();
  const [id, crypto] = await Promise.all([helper.createIdPackage(keys.sKey), resolvedQubicCrypto]);
  if (keys.pKey && id.publicId !== keys.pKey) {
    throw new Error("SignerService(QUBIC_KEYS): public key does not match seed");
  }
  return {
    privateKey: id.privateKey,
    publicKey: id.publicKey,
    sign(serialized: Uint8Array): string {
      const digest = new Uint8Array(QUBIC_DIGEST_LENGTH);
      crypto.K12(serialized, digest, QUBIC_DIGEST_LENGTH);
      const signature = crypto.schnorrq.sign(id.privateKey, id.publicKey, digest);
      return Buffer.from(signature).toString("base64");
    },
  };
}

export async function signLockOrderForSolanaWithSigner(
  order: OrderInput,
  signer: SolanaSigner,
): Promise<string> {
  const digest = createHash("sha256").update(serializeOrderForSolana(order)).digest();
  const signableMessage = createSignableMessage(digest);
  const [sigDict] = await signer.signMessages([signableMessage]);
  if (!sigDict || !(signer.address in sigDict)) {
    throw new Error("SignerService(SOLANA_KEYS): signer did not return a signature");
  }
  return normalizeSignatureValue(sigDict[signer.address]);
}

async function readKeysFromFile(
  variableName: "SOLANA_KEYS" | "QUBIC_KEYS",
  filePath: string,
  fastify: FastifyInstance,
): Promise<SignerKeys> {
  const prefix = `SignerService(${variableName})`;
  const fileManager = fastify.getDecorator<FileManager>(kFileManager);
  const validation: ValidationService = fastify.getDecorator(kValidation);
  const parsed: unknown = await fileManager.readJsonFile(prefix, filePath);
  validation.assertValid<SignerKeys>(SignerKeysSchema, parsed, prefix);
  return parsed;
}

export default fp(
  async function signerService(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);

    const [solanaKeys, qubicKeys] = await Promise.all([
      readKeysFromFile("SOLANA_KEYS", config.SOLANA_KEYS, fastify),
      readKeysFromFile("QUBIC_KEYS", config.QUBIC_KEYS, fastify),
    ]);

    const [solanaSigner, qubicSigner] = await Promise.all([
      createSolanaSignerFromKeys(solanaKeys),
      createQubicSignerFromKeys(qubicKeys),
    ]);

    const signLockOrderForSolana = (order: OrderInput) =>
      signLockOrderForSolanaWithSigner(order, solanaSigner);

    const signUnlockOrderForQubic = async (order: OrderInput) =>
      qubicSigner.sign(serializeOrderForQubic(order));

    fastify.decorate(kSignerService, {
      signLockOrderForSolana,
      signUnlockOrderForQubic,
    });
  },
  {
    name: "signer-service",
    dependencies: ["env", "validation"],
  },
);
