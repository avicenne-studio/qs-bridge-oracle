import { OracleOrder } from "../../indexer/schemas/order.js";
import type { FastifyBaseLogger } from "fastify";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import {
  type QubicLockEventPayload,
  type QubicOverrideLockEventPayload,
  type QubicUnlockEventPayload,
} from "./schemas/qubic-event.js";
import type { RelayerFeeAcceptance } from "../../relayer/relayer-fee-acceptance.js";
import { type SignerService } from "../../signer/signer.service.js";
import { bytesToHex, nonceToBytes } from "../../common/bytes.js";
import { orderIdFromSignature } from "../../common/order-id.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../../common/protocol.js";

type Logger = FastifyBaseLogger;

type QubicOrderDependencies = {
  ordersRepository: OrdersRepository;
  signerService: SignerService;
  config: { TOKEN_MINT: string };
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

function normalizeNonce(nonce: string): string {
  return bytesToHex(nonceToBytes(nonce));
}

function serializeSourcePayload(payload: QubicOrderSourcePayloadV1): string {
  return JSON.stringify(payload);
}

function buildSourcePayload(
  event: QubicLockEventPayload,
): QubicOrderSourcePayloadV1 {
  return {
    v: 1,
    nonce: normalizeNonce(event.nonce),
    fromAddress: event.fromAddress,
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
  };
}

function createOrderFromLockEvent(
  event: QubicLockEventPayload,
  signature: string,
  orderId: string,
  sourceNonce: string,
  originTrxHash: string,
  oracleAcceptToRelay: boolean,
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
    relay_attempts: 0,
    source_nonce: sourceNonce,
    source_payload: serializeSourcePayload(buildSourcePayload(event)),
  };
}

export function createFailedOrderFromLockEvent(
  event: QubicLockEventPayload,
  meta: { signature?: string },
  failureReasonPublic: string,
): OracleOrder {
  const sourceNonce = normalizeNonce(event.nonce);
  const signatureSeed = meta.signature ?? sourceNonce;
  const orderId = orderIdFromSignature(signatureSeed);

  return {
    id: orderId,
    source: "qubic",
    dest: "solana",
    from: event.fromAddress,
    to: event.toAddress,
    amount: event.amount,
    relayerFee: event.relayerFee,
    origin_trx_hash: signatureSeed,
    signature: signatureSeed,
    status: "failed",
    oracle_accept_to_relay: false,
    relay_attempts: 0,
    source_nonce: sourceNonce,
    source_payload: serializeSourcePayload(buildSourcePayload(event)),
    failure_reason_public: failureReasonPublic,
  };
}

export function createQubicOrderHandlers(deps: QubicOrderDependencies) {
  const { ordersRepository, signerService, config, logger, relayerFeeAcceptance } = deps;

  const handleLockEvent = async (
    event: QubicLockEventPayload,
    meta?: { signature?: string },
  ) => {
    logger.debug(
      {
        amount: event.amount,
        relayerFee: event.relayerFee,
        nonce: event.nonce,
        from: event.fromAddress,
        to: event.toAddress,
      },
      "Qubic lock event payload",
    );

    const sourceNonce = normalizeNonce(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (existing) {
      logger.info({ orderId: existing.id }, "Qubic lock order already exists");
      return;
    }

    const signatureSeed = meta?.signature ?? sourceNonce;
    const originTrxHash = meta?.signature ?? sourceNonce;
    const orderId = orderIdFromSignature(signatureSeed);
    const signature = await signerService.signQubicToSolanaOrder({
      tokenMint: config.TOKEN_MINT,
      ...event,
    });
    logger.info({ orderId, signature }, "Qubic lock order signed");
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToSolana(
      BigInt(event.amount),
      BigInt(event.relayerFee),
    );

    const order = createOrderFromLockEvent(
      event,
      signature,
      orderId,
      sourceNonce,
      originTrxHash,
      oracleAcceptToRelay,
    );

    await ordersRepository.create(order);
    logger.info({ orderId }, "Qubic lock order stored");
  };

  const handleOverrideLockEvent = async (
    event: QubicOverrideLockEventPayload,
  ) => {
    logger.debug(
      {
        relayerFee: event.relayerFee,
        nonce: event.nonce,
        to: event.toAddress,
      },
      "Qubic override lock event payload",
    );

    const sourceNonce = normalizeNonce(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (!existing) {
      logger.warn(
        { sourceNonce },
        "Qubic override event received for unknown order",
      );
      return;
    }
    if (existing.status === "finalized") {
      logger.info(
        { orderId: existing.id },
        "Qubic override event ignored because order is finalized",
      );
      return;
    }

    const updatedSignature = await signerService.signQubicToSolanaOrder({
      tokenMint: config.TOKEN_MINT,
      fromAddress: existing.from,
      toAddress: event.toAddress,
      amount: existing.amount,
      relayerFee: event.relayerFee,
      nonce: event.nonce,
    });
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToSolana(
      BigInt(existing.amount),
      BigInt(event.relayerFee),
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
    meta?: { signature?: string },
  ) => {
    logger.debug(
      {
        amount: event.amount,
        nonce: event.nonce,
        to: event.toAddress,
      },
      "Qubic unlock event payload",
    );

    const sourceNonce = normalizeNonce(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (!existing) {
      logger.warn(
        { sourceNonce },
        "Qubic unlock event received for unknown order",
      );
      return;
    }

    if (!meta?.signature) {
      logger.warn(
        { orderId: existing.id },
        "Qubic unlock event missing signature",
      );
      return;
    }

    await ordersRepository.update(existing.id, {
      destination_trx_hash: meta.signature,
      status: "finalized",
    });

    logger.info({ orderId: existing.id }, "Qubic unlock order updated");
  };

  return {
    handleLockEvent,
    handleOverrideLockEvent,
    handleUnlockEvent,
  };
}
