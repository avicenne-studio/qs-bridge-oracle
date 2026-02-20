import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  createKeyPairSignerFromBytes,
  createSignableMessage,
} from "@solana/kit";
import qubicCrypto from "@qubic-lib/qubic-ts-library/dist/crypto/index.js";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { SignerKeys, SignerKeysSchema } from "./schemas/keys.js";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import { kFileManager, type FileManager } from "../../infra/@file-manager.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import {
  decodeSecretKey,
  normalizeSignatureValue,
  assertFixedBytes,
} from "../common/bytes.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../common/protocol.js";
import {
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
  type BridgeOrderFields,
} from "../common/solana/program.js";

export type OutboundOrderInput = {
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
  signLockOrderForSolana: (order: OutboundOrderInput) => Promise<string>;
  signOutboundOrderForQubic: (order: OutboundOrderInput) => Promise<string>;
};

export const kSignerService = Symbol("app.signerService");

function serializeOrder(order: OutboundOrderInput): Uint8Array {
  assertFixedBytes(order.tokenIn, "tokenIn", 32);
  assertFixedBytes(order.tokenOut, "tokenOut", 32);
  assertFixedBytes(order.fromAddress, "fromAddress", 32);
  assertFixedBytes(order.toAddress, "toAddress", 32);
  assertFixedBytes(order.nonce, "nonce", 32);
  const fields: BridgeOrderFields = {
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
  };
  return serializeBridgeOrder(fields);
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

const resolvedQubicCrypto = (
  qubicCrypto as unknown as { default: Promise<QubicCrypto> }
).default;
const QUBIC_DIGEST_LENGTH = 32;

async function createSolanaSignerFromKeys(
  keys: SignerKeys,
): Promise<SolanaSigner> {
  const secretKeyBytes = decodeSecretKey(keys.sKey);
  const signer = await createKeyPairSignerFromBytes(secretKeyBytes);
  if (keys.pKey && signer.address !== keys.pKey) {
    throw new Error(
      "SignerService(SOLANA_KEYS): public key does not match secret key",
    );
  }
  return signer;
}

async function createQubicSignerFromKeys(
  keys: SignerKeys,
): Promise<QubicSigner> {
  const helper = new QubicHelper();
  const [id, crypto] = await Promise.all([
    helper.createIdPackage(keys.sKey),
    resolvedQubicCrypto,
  ]);
  if (keys.pKey && id.publicId !== keys.pKey) {
    throw new Error(
      "SignerService(QUBIC_KEYS): public key does not match seed",
    );
  }
  return {
    privateKey: id.privateKey,
    publicKey: id.publicKey,
    sign(serialized: Uint8Array): string {
      const digest = new Uint8Array(QUBIC_DIGEST_LENGTH);
      crypto.K12(serialized, digest, QUBIC_DIGEST_LENGTH);
      const signature = crypto.schnorrq.sign(
        id.privateKey,
        id.publicKey,
        digest,
      );
      return Buffer.from(signature).toString("base64");
    },
  };
}

export async function signLockOrderForSolanaWithSigner(
  order: OutboundOrderInput,
  signer: SolanaSigner,
): Promise<string> {
  const digest = createHash("sha256").update(serializeOrder(order)).digest();
  const signableMessage = createSignableMessage(digest);
  const [sigDict] = await signer.signMessages([signableMessage]);
  if (!sigDict || !(signer.address in sigDict)) {
    throw new Error(
      "SignerService(SOLANA_KEYS): signer did not return a signature",
    );
  }
  return normalizeSignatureValue(sigDict[signer.address]);
}

async function readKeysFromFile(
  variableName: "SOLANA_KEYS" | "QUBIC_KEYS",
  filePath: string,
  fastify: FastifyInstance,
): Promise<SignerKeys> {
  const prefix = `SignerService(${variableName})`;
  const fileManager: FileManager = fastify.getDecorator(kFileManager);
  const validation: ValidationService = fastify.getDecorator(kValidation);
  const parsed = await fileManager.readJsonFile(prefix, filePath);
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

    let cachedSolanaSigner: SolanaSigner | null = null;
    const ensureSolanaSigner = async () => {
      if (!cachedSolanaSigner) {
        cachedSolanaSigner = await createSolanaSignerFromKeys(solanaKeys);
      }
      return cachedSolanaSigner;
    };

    let cachedQubicSigner: QubicSigner | null = null;
    const ensureQubicSigner = async () => {
      if (!cachedQubicSigner) {
        cachedQubicSigner = await createQubicSignerFromKeys(qubicKeys);
      }
      return cachedQubicSigner;
    };

    const signLockOrderForSolana = async (order: OutboundOrderInput) =>
      signLockOrderForSolanaWithSigner(order, await ensureSolanaSigner());

    const signOutboundOrderForQubic = async (order: OutboundOrderInput) =>
      (await ensureQubicSigner()).sign(serializeOrder(order));

    fastify.decorate(kSignerService, {
      signLockOrderForSolana,
      signOutboundOrderForQubic,
    });
  },
  {
    name: "signer-service",
    dependencies: ["env", "validation"],
  },
);
