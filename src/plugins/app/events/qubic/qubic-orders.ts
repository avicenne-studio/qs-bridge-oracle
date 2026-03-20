import { OracleOrder } from "../../indexer/schemas/order.js";
import type { FastifyBaseLogger } from "fastify";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import type { RelayerFeeAcceptance } from "../../relayer/relayer-fee-acceptance.js";
import { type SignerService, type OrderInput } from "../../signer/signer.service.js";
import { bytesToHex, nonceToBytes } from "../../common/bytes.js";
import { orderIdFromSignature } from "../../common/order-id.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../../common/protocol.js";
import { Network } from "../../common/schemas/common.js";
import { QUBIC_TOKEN_ADDRESS } from "../../common/qubic/encoding.js";
import { address, getAddressEncoder } from "@solana/kit";
import { type QubicLockEvent, type QubicOverrideLockEvent, type QubicUnlockEvent } from "./qubic-event-mapper.js";
import { type QubicLockEventPayload } from "./schemas/qubic-event.js";

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
  orderEra: number;
};

const addressEncoder = getAddressEncoder();

function normalizeNonce(nonce: string): string {
  return bytesToHex(nonceToBytes(nonce));
}

type QubicOrderFields = Pick<QubicLockEvent, "fromAddress" | "toAddress" | "amount" | "relayerFee" | "nonce" | "orderEra">;

function buildOrderToSign(
  tokenMint: string,
  event: QubicOrderFields,
): OrderInput {
  return {
    networkIn: Network.Qubic,
    networkOut: Network.Solana,
    tokenIn: QUBIC_TOKEN_ADDRESS,
    tokenOut: new Uint8Array(addressEncoder.encode(address(tokenMint))),
    fromAddress: event.fromAddress,
    toAddress: event.toAddress,
    amount: event.amount,
    relayerFee: event.relayerFee,
    nonce: event.nonce,
    orderEra: event.orderEra,
  };
}

function serializeSourcePayload(payload: QubicOrderSourcePayloadV1): string {
  return JSON.stringify(payload);
}

function buildSourcePayload(event: QubicLockEvent): QubicOrderSourcePayloadV1 {
  return {
    v: 1,
    nonce: bytesToHex(event.nonce),
    fromAddress: bytesToHex(event.fromAddress),
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    orderEra: event.orderEra,
  };
}

function createOrderFromLockEvent(
  event: QubicLockEvent,
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
    from: bytesToHex(event.fromAddress),
    to: bytesToHex(event.toAddress),
    amount: event.amount.toString(),
    relayerFee: event.relayerFee.toString(),
    origin_trx_hash: originTrxHash,
    signature,
    status: "pending",
    oracle_accept_to_relay: oracleAcceptToRelay,
    relay_attempts: 0,
    source_nonce: sourceNonce,
    source_payload: serializeSourcePayload(buildSourcePayload(event)),
    order_era: event.orderEra,
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
    source_payload: serializeSourcePayload({
      v: 1,
      nonce: normalizeNonce(event.nonce),
      fromAddress: event.fromAddress,
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      orderEra: Number(event.orderEra),
    }),
    order_era: Number(event.orderEra),
    failure_reason_public: failureReasonPublic,
  };
}

export function createQubicOrderHandlers(deps: QubicOrderDependencies) {
  const {
    ordersRepository,
    signerService,
    config,
    logger,
    relayerFeeAcceptance,
  } = deps;

  const handleLockEvent = async (
    event: QubicLockEvent,
    meta?: { signature?: string },
  ) => {
    logger.debug(
      {
        amount: event.amount,
        relayerFee: event.relayerFee,
        nonce: bytesToHex(event.nonce),
        from: bytesToHex(event.fromAddress),
        to: bytesToHex(event.toAddress),
      },
      "Qubic lock event payload",
    );

    const sourceNonce = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (existing) {
      logger.info({ orderId: existing.id }, "Qubic lock order already exists");
      return;
    }

    const signatureSeed = meta?.signature ?? sourceNonce;
    const originTrxHash = meta?.signature ?? sourceNonce;
    const orderId = orderIdFromSignature(signatureSeed);
    const orderToSign = buildOrderToSign(config.TOKEN_MINT, event);
    const signature = await signerService.signLockOrderForSolana(orderToSign);
    logger.info({ orderId, signature }, "Qubic lock order signed");
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToSolana(
      event.amount,
      event.relayerFee,
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
    event: QubicOverrideLockEvent,
  ) => {
    logger.debug(
      {
        relayerFee: event.relayerFee,
        nonce: bytesToHex(event.nonce),
        to: bytesToHex(event.toAddress),
      },
      "Qubic override lock event payload",
    );

    const sourceNonce = bytesToHex(event.nonce);
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

    const orderToSign = buildOrderToSign(config.TOKEN_MINT, event);
    const updatedSignature = await signerService.signLockOrderForSolana(orderToSign);
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToSolana(
      event.amount,
      event.relayerFee,
    );

    await ordersRepository.update(existing.id, {
      to: bytesToHex(event.toAddress),
      relayerFee: event.relayerFee.toString(),
      signature: updatedSignature,
      oracle_accept_to_relay: oracleAcceptToRelay,
    });

    logger.info({ orderId: existing.id }, "Qubic lock order updated");
  };

  const handleUnlockEvent = async (
    event: QubicUnlockEvent,
    meta?: { signature?: string },
  ) => {
    logger.debug(
      {
        amount: event.amount,
        nonce: bytesToHex(event.nonce),
        to: bytesToHex(event.toAddress),
      },
      "Qubic unlock event payload",
    );

    const sourceNonce = bytesToHex(event.nonce);
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
