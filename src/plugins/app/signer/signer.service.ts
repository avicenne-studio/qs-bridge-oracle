import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
} from "@solana/kit";
import {
  SignerKeys,
  SignerKeysSchema,
} from "./schemas/keys.js";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import { kFileManager, type FileManager } from "../../infra/@file-manager.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import {
  serializeBridgeOrder,
  decodeSecretKey,
  normalizeSignatureValue,
  parseU32,
  parseU64,
  assertFixedBytes,
  type BridgeOrderFields,
} from "../common/solana/index.js";

export type QubicLockOrderToSign = {
  protocolName: string;
  protocolVersion: string;
  contractAddress: Uint8Array;
  networkIn: number | string;
  networkOut: number | string;
  tokenIn: Uint8Array;
  tokenOut: Uint8Array;
  fromAddress: Uint8Array;
  toAddress: Uint8Array;
  amount: bigint | number | string;
  relayerFee: bigint | number | string;
  nonce: Uint8Array;
};

type SolanaSigner = {
  address: string;
  signMessages: (
    messages: ReturnType<typeof createSignableMessage>[]
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
};

type QubicLockOrderMessage = {
  protocolName: string;
  protocolVersion: string;
  contractAddress: Uint8Array;
  networkIn: number;
  networkOut: number;
  tokenIn: Uint8Array;
  tokenOut: Uint8Array;
  fromAddress: Uint8Array;
  toAddress: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  nonce: Uint8Array;
};

export type SignerService = {
  signLockOrderForSolana: (order: QubicLockOrderToSign) => Promise<string>;
};

export const kSignerService = Symbol("app.signerService");

async function readKeysFromFile(
  variableName: "SOLANA_KEYS" | "QUBIC_KEYS",
  filePath: string,
  fastify: FastifyInstance
): Promise<SignerKeys> {
  const prefix = `SignerService(${variableName})`;
  const fileManager: FileManager = fastify.getDecorator(kFileManager);
  const validation: ValidationService = fastify.getDecorator(kValidation);
  const parsed = await fileManager.readJsonFile(prefix, filePath);
  validation.assertValid<SignerKeys>(SignerKeysSchema, parsed, prefix);
  return parsed;
}


function normalizeQubicLockOrder(order: QubicLockOrderToSign): QubicLockOrderMessage {
  return {
    protocolName: order.protocolName,
    protocolVersion: order.protocolVersion,
    contractAddress: order.contractAddress,
    networkIn: parseU32(order.networkIn, "networkIn"),
    networkOut: parseU32(order.networkOut, "networkOut"),
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    fromAddress: order.fromAddress,
    toAddress: order.toAddress,
    amount: parseU64(order.amount, "amount"),
    relayerFee: parseU64(order.relayerFee, "relayerFee"),
    nonce: order.nonce,
  };
}

function serializeQubicLockOrder(order: QubicLockOrderToSign): Uint8Array {
  const normalized = normalizeQubicLockOrder(order);
  assertFixedBytes(normalized.contractAddress, "contractAddress", 32);
  assertFixedBytes(normalized.tokenIn, "tokenIn", 32);
  assertFixedBytes(normalized.tokenOut, "tokenOut", 32);
  assertFixedBytes(normalized.fromAddress, "fromAddress", 32);
  assertFixedBytes(normalized.toAddress, "toAddress", 32);
  assertFixedBytes(normalized.nonce, "nonce", 32);

  return serializeBridgeOrder(normalized as BridgeOrderFields);
}


async function createSolanaSignerFromKeys(keys: SignerKeys): Promise<SolanaSigner> {
  const secretKeyBytes = decodeSecretKey(keys.sKey);
  const signer = await createKeyPairSignerFromBytes(secretKeyBytes);
  if (keys.pKey && signer.address !== keys.pKey) {
    throw new Error("SignerService(SOLANA_KEYS): public key does not match secret key");
  }
  return signer;
}

export async function signLockOrderForSolanaWithSigner(
  order: QubicLockOrderToSign,
  signer: SolanaSigner
): Promise<string> {
  const serializedOrder = serializeQubicLockOrder(order);
  const digest = createHash("sha256").update(serializedOrder).digest();
  const signableMessage = createSignableMessage(digest);
  const [sigDict] = await signer.signMessages([signableMessage]);
  if (!sigDict || !(signer.address in sigDict)) {
    throw new Error("SignerService(SOLANA_KEYS): signer did not return a signature");
  }
  return normalizeSignatureValue(sigDict[signer.address]);
}

export default fp(
  async function signerService(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const solana = await readKeysFromFile(
      "SOLANA_KEYS",
      config.SOLANA_KEYS,
      fastify
    );
    await readKeysFromFile(
      "QUBIC_KEYS",
      config.QUBIC_KEYS,
      fastify
    );

    let cachedSigner: SolanaSigner | null = null;
    const signLockOrderForSolana = async (order: QubicLockOrderToSign) => {
      if (!cachedSigner) {
        cachedSigner = await createSolanaSignerFromKeys(solana);
      }
      return signLockOrderForSolanaWithSigner(order, cachedSigner);
    };

    fastify.decorate(kSignerService, { signLockOrderForSolana });
  },
  {
    name: "signer-service",
    dependencies: ["env", "validation"],
  }
);
