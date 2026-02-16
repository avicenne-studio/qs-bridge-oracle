import { OracleOrder } from "../../indexer/schemas/order.js";
import type { FastifyBaseLogger } from "fastify";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  type QubicLockEventPayload,
  type QubicOverrideLockEventPayload,
  type QubicUnlockEventPayload,
} from "./schemas/qubic-event.js";
import type { RelayerFeeAcceptance } from "../../relayer/relayer-fee-acceptance.js";

const PROTOCOL_NAME = "qs-bridge";
const PROTOCOL_VERSION = "1";

type Logger = FastifyBaseLogger;

type QubicOrderDependencies = {
  ordersRepository: OrdersRepository;
  logger: Logger;
  relayerFeeAcceptance: RelayerFeeAcceptance;
};

type QubicOrderSourcePayloadV1 = {
  v: 1;
  nonce: string;
  fromAddress: string;
  protocol: string;
  version: string;
};

function formatUuidFromBytes(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function orderIdFromSignature(signature: string): string {
  const bytes = createHash("sha256").update(signature).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuidFromBytes(bytes.subarray(0, 16));
}

function serializeSourcePayload(payload: QubicOrderSourcePayloadV1): string {
  return JSON.stringify(payload);
}

function buildSourcePayload(event: QubicLockEventPayload): QubicOrderSourcePayloadV1 {
  return {
    v: 1,
    nonce: event.nonce,
    fromAddress: event.fromAddress,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
  };
}

function createPlaceholderSignature(): string {
  // TODO: Replace placeholder signature with real Solana signature.
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function createOrderFromLockEvent(
  event: QubicLockEventPayload,
  signature: string,
  orderId: string,
  sourceNonce: string,
  originTrxHash: string,
  oracleAcceptToRelay: boolean
): OracleOrder {
  return {
    id: orderId,
    source: "qubic",
    dest: "solana",
    from: event.fromAddress,
    to: event.toAddress,
    amount: event.amount,
    relayerFee: event.relayerFee,
    origin_trx_hash: originTrxHash,
    signature,
    status: "pending",
    oracle_accept_to_relay: oracleAcceptToRelay,
    source_nonce: sourceNonce,
    source_payload: serializeSourcePayload(buildSourcePayload(event)),
  };
}

export function createQubicOrderHandlers(deps: QubicOrderDependencies) {
  const { ordersRepository, logger, relayerFeeAcceptance } = deps;

  const handleLockEvent = async (
    event: QubicLockEventPayload,
    meta?: { signature?: string }
  ) => {
    logger.debug(
      {
        amount: event.amount,
        relayerFee: event.relayerFee,
        nonce: event.nonce,
        from: event.fromAddress,
        to: event.toAddress,
      },
      "Qubic lock event payload"
    );

    const sourceNonce = event.nonce;
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (existing) {
      logger.info(
        { orderId: existing.id },
        "Qubic lock order already exists"
      );
      return;
    }

    const signatureSeed = meta?.signature ?? sourceNonce;
    const originTrxHash = meta?.signature ?? sourceNonce;
    const orderId = orderIdFromSignature(signatureSeed);
    const signature = createPlaceholderSignature();
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToSolana(
      BigInt(event.amount),
      BigInt(event.relayerFee)
    );

    const order = createOrderFromLockEvent(
      event,
      signature,
      orderId,
      sourceNonce,
      originTrxHash,
      oracleAcceptToRelay
    );

    await ordersRepository.create(order);
    logger.info({ orderId }, "Qubic lock order stored");
  };

  const handleOverrideLockEvent = async (event: QubicOverrideLockEventPayload) => {
    logger.debug(
      {
        relayerFee: event.relayerFee,
        nonce: event.nonce,
        to: event.toAddress,
      },
      "Qubic override lock event payload"
    );

    const sourceNonce = event.nonce;
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (!existing) {
      logger.warn(
        { sourceNonce },
        "Qubic override event received for unknown order"
      );
      return;
    }
    if (existing.status === "finalized") {
      logger.info(
        { orderId: existing.id },
        "Qubic override event ignored because order is finalized"
      );
      return;
    }

    const updatedSignature = createPlaceholderSignature();
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToSolana(
      BigInt(existing.amount),
      BigInt(event.relayerFee)
    );

    await ordersRepository.update(existing.id, {
      to: event.toAddress,
      relayerFee: event.relayerFee,
      signature: updatedSignature,
      oracle_accept_to_relay: oracleAcceptToRelay,
    });

    logger.info({ orderId: existing.id }, "Qubic lock order updated");
  };

  const handleUnlockEvent = async (
    event: QubicUnlockEventPayload,
    meta?: { signature?: string }
  ) => {
    logger.debug(
      {
        amount: event.amount,
        nonce: event.nonce,
        to: event.toAddress,
      },
      "Qubic unlock event payload"
    );

    const sourceNonce = event.nonce;
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (!existing) {
      logger.warn(
        { sourceNonce },
        "Qubic unlock event received for unknown order"
      );
      return;
    }

    if (!meta?.signature) {
      logger.warn(
        { orderId: existing.id },
        "Qubic unlock event missing signature"
      );
      return;
    }

    await ordersRepository.update(existing.id, {
      destination_trx_hash: meta.signature,
    });

    logger.info({ orderId: existing.id }, "Qubic unlock order updated");
  };

  return {
    handleLockEvent,
    handleOverrideLockEvent,
    handleUnlockEvent,
  };
}
