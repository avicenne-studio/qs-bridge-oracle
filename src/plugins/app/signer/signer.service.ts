import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { serialize } from "borsh";
import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
} from "@solana/kit";
import {
  SignerKeys,
  SignerKeysSchema,
} from "./schemas/keys.js";

const MAX_U64 = (1n << 64n) - 1n;

export type SolanaOrderToSign = {
  protocolName: string;
  protocolVersion: number | string;
  destinationChainId: number | string;
  contractAddress: string;
  networkIn: string;
  networkOut: string;
  tokenIn: string;
  tokenOut: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint | number | string;
  relayerFee: bigint | number | string;
  nonce: bigint | number | string;
};

type SolanaSigner = {
  address: string;
  signMessages: (
    messages: ReturnType<typeof createSignableMessage>[]
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
};

type SolanaOrderMessage = {
  protocolName: string;
  protocolVersion: number;
  destinationChainId: number;
  contractAddress: string;
  networkIn: string;
  networkOut: string;
  tokenIn: string;
  tokenOut: string;
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  relayerFee: bigint;
  nonce: bigint;
};

const SolanaOrderSchema = {
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

type SignerService = {
  signSolanaOrder: (order: SolanaOrderToSign) => Promise<string>;
};

declare module "fastify" {
  interface FastifyInstance {
    signerService: SignerService;
  }
}

async function readKeysFromFile(
  variableName: "SOLANA_KEYS" | "QUBIC_KEYS",
  filePath: string,
  fastify: FastifyInstance
): Promise<SignerKeys> {
  const prefix = `SignerService(${variableName})`;
  const parsed = await fastify.fileManager.readJsonFile(prefix, filePath);
  fastify.validation.assertValid<SignerKeys>(SignerKeysSchema, parsed, prefix);
  return parsed;
}

function parseU32(value: number | string, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`SignerService(SOLANA_KEYS): ${field} must be uint32`);
  }
  return parsed;
}

function parseU64(value: bigint | number | string, field: string): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : BigInt(typeof value === "string" ? value : Math.trunc(value));
  if (parsed < 0n || parsed > MAX_U64) {
    throw new Error(`SignerService(SOLANA_KEYS): ${field} must be uint64`);
  }
  return parsed;
}

function normalizeSolanaOrder(order: SolanaOrderToSign): SolanaOrderMessage {
  return {
    protocolName: order.protocolName,
    protocolVersion: parseU32(order.protocolVersion, "protocolVersion"),
    destinationChainId: parseU32(order.destinationChainId, "destinationChainId"),
    contractAddress: order.contractAddress,
    networkIn: order.networkIn,
    networkOut: order.networkOut,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    fromAddress: order.fromAddress,
    toAddress: order.toAddress,
    amount: parseU64(order.amount, "amount"),
    relayerFee: parseU64(order.relayerFee, "relayerFee"),
    nonce: parseU64(order.nonce, "nonce"),
  };
}

function serializeSolanaOrder(order: SolanaOrderToSign): Uint8Array {
  const normalized = normalizeSolanaOrder(order);
  return serialize(SolanaOrderSchema, normalized);
}

function normalizeSignatureValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  throw new Error("SignerService(SOLANA_KEYS): unsupported signature format");
}

function decodeSecretKey(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  const bytes = new Uint8Array(Buffer.from(trimmed, "base64"));
  if (bytes.length !== 64) {
    throw new Error("SignerService(SOLANA_KEYS): secret key must be 64 bytes");
  }
  return bytes;
}

async function createSolanaSignerFromKeys(keys: SignerKeys): Promise<SolanaSigner> {
  const secretKeyBytes = decodeSecretKey(keys.sKey);
  const signer = await createKeyPairSignerFromBytes(secretKeyBytes);
  if (keys.pKey && signer.address !== keys.pKey) {
    throw new Error("SignerService(SOLANA_KEYS): public key does not match secret key");
  }
  return signer;
}

async function signSolanaOrderWithSigner(
  order: SolanaOrderToSign,
  signer: SolanaSigner
): Promise<string> {
  const serializedOrder = serializeSolanaOrder(order);
  const digest = createHash("sha256").update(serializedOrder).digest();
  const signableMessage = createSignableMessage(digest);
  const [sigDict] = await signer.signMessages([signableMessage]);
  if (!sigDict || !(signer.address in sigDict)) {
    throw new Error("SignerService(SOLANA_KEYS): signer did not return a signature");
  }
  return normalizeSignatureValue(sigDict[signer.address]);
}

export const __test__ = {
  decodeSecretKey,
  normalizeSignatureValue,
  signSolanaOrderWithSigner,
};

export default fp(
  async function signerService(fastify: FastifyInstance) {
    const solana = await readKeysFromFile(
      "SOLANA_KEYS",
      fastify.config.SOLANA_KEYS,
      fastify
    );
    await readKeysFromFile(
      "QUBIC_KEYS",
      fastify.config.QUBIC_KEYS,
      fastify
    );

    let cachedSigner: SolanaSigner | null = null;
    const signSolanaOrder = async (order: SolanaOrderToSign) => {
      if (!cachedSigner) {
        cachedSigner = await createSolanaSignerFromKeys(solana);
      }
      return signSolanaOrderWithSigner(order, cachedSigner);
    };

    fastify.decorate("signerService", { signSolanaOrder });
  },
  {
    name: "signer-service",
    dependencies: ["env", "validation"],
  }
);
