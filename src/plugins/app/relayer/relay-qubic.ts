import { Buffer } from "node:buffer";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import qubicCryptoModule from "@qubic-lib/qubic-ts-library";
import type { FastifyInstance } from "fastify";
import { nonceToBytes, solanaAddressToBytes } from "../common/bytes.js";
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
  qubicAddressToBytes,
  QUBIC_TOKEN_ADDRESS,
  QUBIC_CONTRACT_ADDRESS_BYTES,
} from "../common/qubic/encoding.js";
import { address, getAddressEncoder } from "@solana/kit";
import { serializeQsbOrderMessage } from "../common/qubic/qsb-message.js";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from "../common/protocol.js";
import {
  kQubicContractClient,
  type QubicContractClient,
  FUNC_GET_ORACLES,
  FUNC_IS_ORDER_FILLED,
  decodeGetOracles,
} from "../../infra/qubic-contract-client.js";

export class QubicDefinitiveRelayFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QubicDefinitiveRelayFailure";
  }
}

const UNLOCK_INPUT_TYPE = 3;
const TICK_OFFSET = 5;
const FILL_POLL_INTERVAL_MS = 2000;
// Safety ceiling: if the target tick never arrives (Bob lagging, node stalled),
// stop polling after this many attempts rather than blocking forever.
const FILL_POLL_MAX_ATTEMPTS = 60; // ~120s
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
  contractClient: QubicContractClient;
  qubicSeed: string;
  qubicPublicKey: Uint8Array;
  ordersRepository: OrdersRepository;
  logger: FastifyInstance["log"];
  getCurrentTick?: () => Promise<number>;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
};

export type QubicPreparedRelay = {
  trxHash: string;
  orderHash: string;
  targetTick: number;
};

const addressEncoder = getAddressEncoder();

async function getCurrentNodeTick(nodeUrl: string): Promise<number> {
  const res = await fetch(`${nodeUrl}/live/v1/tick-info`);
  if (!res.ok) throw new Error(`tick-info HTTP ${res.status}`);
  const body = (await res.json()) as { tick?: number; tickInfo?: { tick?: number } };
  const tick = body.tick ?? body.tickInfo?.tick;
  if (typeof tick !== "number" || !Number.isFinite(tick)) {
    throw new Error(`tick-info: unexpected response: ${JSON.stringify(body)}`);
  }
  return tick;
}

function orderFromOracleOrder(order: OracleOrder, tokenMint: string): OrderFields {
  const fromBytes = solanaAddressToBytes(order.from);
  const toBytes = qubicAddressToBytes(order.to);

  const nonceBytes = nonceToBytes(order.source_nonce);
  const tokenMintBytes = new Uint8Array(addressEncoder.encode(address(tokenMint)));

  return {
    fromAddress: fromBytes,
    toAddress: toBytes,
    tokenIn: tokenMintBytes,
    tokenOut: QUBIC_TOKEN_ADDRESS,
    amount: BigInt(order.amount),
    relayerFee: BigInt(order.relayerFee),
    networkIn: SOLANA_NETWORK_ID,
    networkOut: QUBIC_NETWORK_ID,
    nonce: nonceBytes,
    orderEra: order.order_era,
  };
}

async function matchSignaturesToOracles(
  signatures: string[],
  oracleKeys: Uint8Array[],
  orderFields: OrderFields,
): Promise<{ matched: Array<{ signerPublicKey: Uint8Array; signature: Uint8Array }>; orderHash: Uint8Array }> {
  const crypto = await resolvedQubicCrypto;

  const serialized = serializeQsbOrderMessage({
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

  const orderHash = new Uint8Array(32);
  crypto.K12(serialized, orderHash, 32);

  const matched: Array<{ signerPublicKey: Uint8Array; signature: Uint8Array }> = [];
  const usedOracles = new Set<string>();

  for (const sigBase64 of signatures) {
    const sigBytes = new Uint8Array(Buffer.from(sigBase64, "base64"));
    if (sigBytes.length !== 64) continue;

    for (const oracleKey of oracleKeys) {
      const keyHex = Buffer.from(oracleKey).toString("hex");
      if (usedOracles.has(keyHex)) continue;
      if (crypto.schnorrq.verify(oracleKey, orderHash, sigBytes) === 1) {
        matched.push({ signerPublicKey: oracleKey, signature: sigBytes });
        usedOracles.add(keyHex);
        break;
      }
    }
  }

  return { matched, orderHash };
}

async function resolveQubicRelayMaterial(
  order: OracleOrder,
  deps: QubicRelayDeps,
): Promise<{
  matchedSigs: Array<{ signerPublicKey: Uint8Array; signature: Uint8Array }>;
  orderHashHex: string;
  currentTick: number;
  orderFields: OrderFields;
}> {
  const { contractClient } = deps;
  const sigs = await deps.ordersRepository.findSignatures(order.id);
  const orderFields = orderFromOracleOrder(order, deps.config.TOKEN_MINT);

  const oracleKeysHex = await contractClient.queryContractFunction(FUNC_GET_ORACLES, "");
  const oracleKeys = decodeGetOracles(oracleKeysHex);
  const { matched: matchedSigs, orderHash } = await matchSignaturesToOracles(sigs, oracleKeys, orderFields);

  if (matchedSigs.length === 0) {
    throw new Error("No valid oracle signatures could be matched");
  }

  const currentTick =
    deps.getCurrentTick !== undefined
      ? await deps.getCurrentTick()
      : (await contractClient.getBobStatus()).tick;

  return {
    matchedSigs,
    orderHashHex: Buffer.from(orderHash).toString("hex"),
    currentTick,
    orderFields,
  };
}

export async function relayToQubic(
  order: OracleOrder,
  deps: QubicRelayDeps,
): Promise<QubicPreparedRelay> {
  const { contractClient } = deps;
  const { matchedSigs, orderHashHex, currentTick, orderFields } =
    await resolveQubicRelayMaterial(order, deps);

  const unlockInput = buildUnlockInput(orderFields, matchedSigs);
  const targetTick = currentTick + TICK_OFFSET;

  const dest = new PublicKey(QUBIC_CONTRACT_ADDRESS_BYTES);

  const payload = new DynamicPayload(unlockInput.length);
  payload.setPayload(unlockInput);

  const tx = new QubicTransaction()
    .setSourcePublicKey(new PublicKey(deps.qubicPublicKey))
    .setDestinationPublicKey(dest)
    .setAmount(new Long(deps.config.QUBIC_INVOCATION_REWARD))
    .setTick(targetTick)
    .setInputType(UNLOCK_INPUT_TYPE)
    .setInputSize(unlockInput.length)
    .setPayload(payload);

  const builtTx = await tx.build(deps.qubicSeed);
  const hexData = Buffer.from(builtTx).toString("hex");
  const txId = tx.getId();

  await contractClient.broadcastTransaction(hexData);

  return {
    trxHash: txId,
    orderHash: orderHashHex,
    targetTick,
  };
}

export async function finalizeQubicRelay(
  order: OracleOrder,
  deps: QubicRelayDeps,
): Promise<{ trxHash: string; orderHash: string }> {
  const { contractClient } = deps;
  const orderHashHex =
    order.destination_order_hash ??
    (await resolveQubicRelayMaterial(order, deps)).orderHashHex;
  const targetTick = order.destination_target_tick;
  if (targetTick === undefined) {
    throw new Error("Missing destination_target_tick for broadcasted Qubic relay");
  }

  // Poll until the contract confirms the fill.
  // Bob can fetch a tick before its indexed contract state reflects that tick.
  // Treating currentFetchingTick > targetTick as definitive can therefore race
  // a successful unlock and mislabel it as expired. Only fail once indexed
  // state has advanced past targetTick and the order is still not filled.
  const pollIntervalMs = deps.pollIntervalMs ?? FILL_POLL_INTERVAL_MS;
  const pollMaxAttempts = deps.pollMaxAttempts ?? FILL_POLL_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
    if (pollIntervalMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    const [result, bobStatus] = await Promise.all([
      contractClient.queryContractFunction(FUNC_IS_ORDER_FILLED, orderHashHex),
      contractClient.getBobStatus(),
    ]);
    const filled = Buffer.from(result, "hex")[0] !== 0;
    if (filled) {
      return {
        trxHash: order.destination_trx_hash ?? "",
        orderHash: orderHashHex,
      };
    }
    if (bobStatus.indexingTick > targetTick) {
      throw new QubicDefinitiveRelayFailure(
        `Qubic unlock definitively failed: target tick ${targetTick} passed (indexing ${bobStatus.indexingTick}, fetching ${bobStatus.fetchingTick}), order not filled (orderHash: ${orderHashHex})`,
      );
    }
  }
  throw new Error(`Qubic unlock timed out after ${pollMaxAttempts} attempts — Bob may be stalled (orderHash: ${orderHashHex})`);
}

export async function buildQubicRelayDeps(
  fastify: FastifyInstance,
  config: EnvConfig,
  ordersRepository: OrdersRepository,
): Promise<QubicRelayDeps> {
  const fileManager = fastify.getDecorator<FileManager>(kFileManager);
  const validation: ValidationService = fastify.getDecorator<ValidationService>(kValidation);
  const contractClient = fastify.getDecorator<QubicContractClient>(kQubicContractClient);

  const raw: unknown = await fileManager.readJsonFile("QubicRelaySigner", config.QUBIC_KEYS);
  validation.assertValid<SignerKeys>(SignerKeysSchema, raw, "QubicRelaySigner");
  const keys = raw as SignerKeys;

  const helper = new QubicHelper();
  const { publicKey } = await helper.createIdPackage(keys.sKey);

  return {
    config,
    contractClient,
    qubicSeed: keys.sKey,
    qubicPublicKey: publicKey,
    ordersRepository,
    logger: fastify.log,
    getCurrentTick: () => getCurrentNodeTick(config.QUBIC_NODE_URL),
  };
}
