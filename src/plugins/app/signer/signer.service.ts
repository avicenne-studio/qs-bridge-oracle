import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
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
import {
  SignerKeys,
  SignerKeysSchema,
} from "./schemas/keys.js";

const MAX_U64 = (1n << 64n) - 1n;

export type SolanaOrderToSign = {
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
  bpsFee: number | string;
  nonce: Uint8Array;
};

type SolanaSigner = {
  address: string;
  signMessages: (
    messages: ReturnType<typeof createSignableMessage>[]
  ) => Promise<readonly Readonly<Record<string, unknown>>[]>;
};

type SolanaOrderMessage = {
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
  bpsFee: number;
  nonce: Uint8Array;
};

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

function parseU16(value: number | string, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new Error(`SignerService(SOLANA_KEYS): ${field} must be uint16`);
  }
  return parsed;
}

function assertFixedBytes(value: Uint8Array, field: string, length: number) {
  if (value.length !== length) {
    throw new Error(`SignerService(SOLANA_KEYS): ${field} must be ${length} bytes`);
  }
}

function normalizeSolanaOrder(order: SolanaOrderToSign): SolanaOrderMessage {
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
    bpsFee: parseU16(order.bpsFee, "bpsFee"),
    nonce: order.nonce,
  };
}

function encodeString(value: string): Uint8Array {
  const stringBytes = getUtf8Encoder().encode(value);
  const lengthBytes = getU32Encoder().encode(stringBytes.length);
  return concatBytes([new Uint8Array(lengthBytes), new Uint8Array(stringBytes)]);
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

function serializeSolanaOrder(order: SolanaOrderToSign): Uint8Array {
  const normalized = normalizeSolanaOrder(order);
  assertFixedBytes(normalized.contractAddress, "contractAddress", 32);
  assertFixedBytes(normalized.tokenIn, "tokenIn", 32);
  assertFixedBytes(normalized.tokenOut, "tokenOut", 32);
  assertFixedBytes(normalized.fromAddress, "fromAddress", 32);
  assertFixedBytes(normalized.toAddress, "toAddress", 32);
  assertFixedBytes(normalized.nonce, "nonce", 32);

  const data: Uint8Array[] = [];
  data.push(encodeString(normalized.protocolName));
  data.push(encodeString(normalized.protocolVersion));
  data.push(new Uint8Array(getBytesEncoder().encode(normalized.contractAddress)));
  data.push(new Uint8Array(getU32Encoder().encode(normalized.networkIn)));
  data.push(new Uint8Array(getU32Encoder().encode(normalized.networkOut)));
  data.push(new Uint8Array(getBytesEncoder().encode(normalized.tokenIn)));
  data.push(new Uint8Array(getBytesEncoder().encode(normalized.tokenOut)));
  data.push(new Uint8Array(getBytesEncoder().encode(normalized.fromAddress)));
  data.push(new Uint8Array(getBytesEncoder().encode(normalized.toAddress)));
  data.push(new Uint8Array(getU64Encoder().encode(normalized.amount)));
  data.push(new Uint8Array(getU64Encoder().encode(normalized.relayerFee)));
  data.push(new Uint8Array(getU16Encoder().encode(normalized.bpsFee)));
  data.push(new Uint8Array(getBytesEncoder().encode(normalized.nonce)));

  return concatBytes(data);
}

export function normalizeSignatureValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  throw new Error("SignerService(SOLANA_KEYS): unsupported signature format");
}

export function decodeSecretKey(encoded: string): Uint8Array {
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

export async function signSolanaOrderWithSigner(
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
