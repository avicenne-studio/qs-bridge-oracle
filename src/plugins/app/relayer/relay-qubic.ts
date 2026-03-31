import { Buffer } from "node:buffer";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import qubicCryptoModule from "@qubic-lib/qubic-ts-library";
import type { FastifyInstance } from "fastify";
import { nonceToBytes } from "../common/bytes.js";
import type { EnvConfig } from "../../infra/env.js";
import type { OracleOrder } from "../indexer/schemas/order.js";
import type { OrdersRepository } from "../indexer/orders.repository.js";
import { kFileManager, type FileManager } from "../../infra/@file-manager.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import { SignerKeysSchema, type SignerKeys } from "../signer/schemas/keys.js";
import {
  buildUnlockInput,
  type OrderFields,
} from "../common/qubic/order-struct.js";
import {
  QSB_CONTRACT_INDEX,
  qubicAddressToBytes,
  QUBIC_TOKEN_ADDRESS,
  QUBIC_CONTRACT_ADDRESS_BYTES,
} from "../common/qubic/encoding.js";
import {
  serializeBridgeOrder,
} from "../common/solana/program.js";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from "../common/protocol.js";

const UNLOCK_INPUT_TYPE = 3;
const TICK_OFFSET = 5;
const QUBIC_NETWORK_ID = 1;
const SOLANA_NETWORK_ID = 2;

type QubicCrypto = {
  schnorrq: {
    verify: (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => number;
  };
  K12: (input: Uint8Array, output: Uint8Array, outputLength: number) => void;
};

const resolvedQubicCrypto = (qubicCryptoModule as unknown as { default: { crypto: Promise<QubicCrypto> } }).default.crypto;

export type QubicRelayDeps = {
  config: EnvConfig;
  qubicSeed: string;
  qubicPublicKey: Uint8Array;
  ordersRepository: OrdersRepository;
  logger: FastifyInstance["log"];
};

type RelayResult = { trxHash: string };

async function getCurrentTick(rpcUrl: string): Promise<number> {
  const res = await fetch(`${rpcUrl}/live/v1/tick-info`);
  if (!res.ok) throw new Error(`tick-info HTTP ${res.status}`);
  const body = (await res.json()) as { tick: number };
  return body.tick;
}

async function getOraclePublicKeys(rpcUrl: string): Promise<Uint8Array[]> {
  const res = await fetch(`${rpcUrl}/live/v1/querySmartContract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contractIndex: QSB_CONTRACT_INDEX,
      inputType: 7,
      inputHex: "",
    }),
  });
  if (!res.ok) throw new Error(`GetOracles HTTP ${res.status}`);
  const body = (await res.json()) as { responseData: string };
  const data = Buffer.from(body.responseData, "base64");

  const count = data.readUInt32LE(0);
  const keys: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(new Uint8Array(data.subarray(4 + i * 32, 4 + (i + 1) * 32)));
  }
  return keys;
}

function orderFromOracleOrder(order: OracleOrder): OrderFields {
  const fromBytes = qubicAddressToBytes(order.from);
  const toBytes = qubicAddressToBytes(order.to);

  const nonceBytes = nonceToBytes(order.source_nonce);

  const networkIn = order.source === "qubic" ? QUBIC_NETWORK_ID : SOLANA_NETWORK_ID;
  const networkOut = order.dest === "qubic" ? QUBIC_NETWORK_ID : SOLANA_NETWORK_ID;

  return {
    fromAddress: fromBytes,
    toAddress: toBytes,
    tokenIn: QUBIC_TOKEN_ADDRESS,
    tokenOut: QUBIC_TOKEN_ADDRESS,
    amount: BigInt(order.amount),
    relayerFee: BigInt(order.relayerFee),
    networkIn,
    networkOut,
    nonce: nonceBytes,
    orderEra: order.order_era,
  };
}

async function matchSignaturesToOracles(
  signatures: string[],
  oracleKeys: Uint8Array[],
  orderFields: OrderFields,
): Promise<Array<{ signerPublicKey: Uint8Array; signature: Uint8Array }>> {
  const crypto = await resolvedQubicCrypto;

  const serialized = serializeBridgeOrder({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: QUBIC_CONTRACT_ADDRESS_BYTES,
    networkIn: orderFields.networkIn,
    networkOut: orderFields.networkOut,
    tokenIn: orderFields.tokenIn,
    tokenOut: orderFields.tokenOut,
    fromAddress: orderFields.fromAddress,
    toAddress: orderFields.toAddress,
    amount: orderFields.amount,
    relayerFee: orderFields.relayerFee,
    nonce: orderFields.nonce,
    orderEra: orderFields.orderEra,
  });

  const digest = new Uint8Array(32);
  crypto.K12(serialized, digest, 32);

  const matched: Array<{ signerPublicKey: Uint8Array; signature: Uint8Array }> = [];

  for (const sigBase64 of signatures) {
    const sigBytes = new Uint8Array(Buffer.from(sigBase64, "base64"));
    if (sigBytes.length !== 64) continue;

    for (const oracleKey of oracleKeys) {
      if (crypto.schnorrq.verify(oracleKey, digest, sigBytes) === 1) {
        matched.push({ signerPublicKey: oracleKey, signature: sigBytes });
        break;
      }
    }
  }

  return matched;
}

export async function relayToQubic(
  order: OracleOrder,
  deps: QubicRelayDeps,
): Promise<RelayResult> {
  const rpcUrl = deps.config.QUBIC_BROADCAST_RPC_URL;

  const sigs = await deps.ordersRepository.findSignatures(order.id);
  const orderFields = orderFromOracleOrder(order);

  const oracleKeys = await getOraclePublicKeys(rpcUrl);
  const matchedSigs = await matchSignaturesToOracles(sigs, oracleKeys, orderFields);

  if (matchedSigs.length === 0) {
    throw new Error("No valid oracle signatures could be matched");
  }

  const unlockInput = buildUnlockInput(orderFields, matchedSigs);

  const tick = await getCurrentTick(rpcUrl);
  const targetTick = tick + TICK_OFFSET;

  const dest = new PublicKey(QUBIC_CONTRACT_ADDRESS_BYTES);

  const payload = new DynamicPayload(unlockInput.length);
  payload.setPayload(unlockInput);

  const tx = new QubicTransaction()
    .setSourcePublicKey(new PublicKey(deps.qubicPublicKey))
    .setDestinationPublicKey(dest)
    .setAmount(new Long(0))
    .setTick(targetTick)
    .setInputType(UNLOCK_INPUT_TYPE)
    .setInputSize(unlockInput.length)
    .setPayload(payload);

  const builtTx = await tx.build(deps.qubicSeed);
  const hexData = Buffer.from(builtTx).toString("hex");
  const txId = tx.getId();

  // Broadcast via the indexer — it captures the event AND forwards to the node
  const indexerUrl = deps.config.QUBIC_RPC_URL;
  const broadcastRes = await fetch(`${indexerUrl}/broadcastTransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: hexData }),
  });

  if (!broadcastRes.ok) {
    const errBody = await broadcastRes.text().catch(() => "");
    throw new Error(`Qubic broadcast failed: HTTP ${broadcastRes.status} — ${errBody}`);
  }

  return { trxHash: txId };
}

export async function buildQubicRelayDeps(
  fastify: FastifyInstance,
  config: EnvConfig,
  ordersRepository: OrdersRepository,
): Promise<QubicRelayDeps> {
  const fileManager = fastify.getDecorator<FileManager>(kFileManager);
  const validation: ValidationService = fastify.getDecorator<ValidationService>(kValidation);

  const raw: unknown = await fileManager.readJsonFile("QubicRelaySigner", config.QUBIC_KEYS);
  validation.assertValid<SignerKeys>(SignerKeysSchema, raw, "QubicRelaySigner");
  const keys = raw as SignerKeys;

  const helper = new QubicHelper();
  const { publicKey } = await helper.createIdPackage(keys.sKey);

  return {
    config,
    qubicSeed: keys.sKey,
    qubicPublicKey: publicKey,
    ordersRepository,
    logger: fastify.log,
  };
}
