import { OracleOrder } from "../../indexer/schemas/order.js";
import type { FastifyBaseLogger } from "fastify";
import { type OutboundEvent } from "../../../../clients/js/types/outboundEvent.js";
import { type OverrideOutboundEvent } from "../../../../clients/js/types/overrideOutboundEvent.js";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import { bytesToHex, hexToBytes } from "../../common/bytes.js";
import { orderIdFromSignature } from "../../common/order-id.js";
import { rawWqubicToQu } from "../../common/decimals.js";
import {
  type SignerService,
  type OrderInput,
} from "../../signer/signer.service.js";
import {
  SolanaOrderSourcePayloadSchema,
  type SolanaOrderSourcePayloadV1,
} from "./schemas/solana-order-source-payload.js";
import { type ValidationService } from "../../common/validation.js";
import type { RelayerFeeAcceptance } from "../../relayer/relayer-fee-acceptance.js";
import { Network } from "../../common/schemas/common.js";

type Logger = FastifyBaseLogger;

type SolanaOrderDependencies = {
  ordersRepository: OrdersRepository;
  signerService: SignerService;
  logger: Logger;
  validation: ValidationService;
  relayerFeeAcceptance: RelayerFeeAcceptance;
};

function serializeSourcePayload(payload: SolanaOrderSourcePayloadV1): string {
  return JSON.stringify(payload);
}

function parseSourcePayload(
  payload: string | undefined,
  validation: ValidationService,
): SolanaOrderSourcePayloadV1 | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload);
    if (!validation.isValid(SolanaOrderSourcePayloadSchema, parsed)) {
      return null;
    }
    return parsed as SolanaOrderSourcePayloadV1;
  } catch {
    return null;
  }
}

function buildSourcePayload(event: OutboundEvent): SolanaOrderSourcePayloadV1 {
  return {
    v: 1,
    networkIn: event.networkIn,
    networkOut: event.networkOut,
    tokenIn: bytesToHex(event.tokenIn),
    tokenOut: bytesToHex(event.tokenOut),
    nonce: bytesToHex(event.nonce),
    orderEra: event.orderEra,
  };
}

function createOrderFromOutboundEvent(
  event: OutboundEvent,
  signature: string,
  orderId: string,
  sourceNonce: string,
  originTrxHash: string,
  oracleAcceptToRelay: boolean,
): OracleOrder {
  return {
    id: orderId,
    source: "solana",
    dest: "qubic",
    from: bytesToHex(event.fromAddress),
    to: bytesToHex(event.toAddress),
    amount: rawWqubicToQu(event.amount).toString(),
    relayerFee: rawWqubicToQu(event.relayerFee).toString(),
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

export function createFailedOrderFromOutboundEvent(
  event: OutboundEvent,
  meta: { signature?: string },
  failureReasonPublic: string,
): OracleOrder {
  const sourceNonce = bytesToHex(event.nonce);
  const signatureSeed = meta.signature ?? sourceNonce;
  const orderId = orderIdFromSignature(signatureSeed);
  return {
    id: orderId,
    source: "solana",
    dest: "qubic",
    from: bytesToHex(event.fromAddress),
    to: bytesToHex(event.toAddress),
    amount: rawWqubicToQu(event.amount).toString(),
    relayerFee: rawWqubicToQu(event.relayerFee).toString(),
    origin_trx_hash: signatureSeed,
    signature: signatureSeed,
    status: "failed",
    oracle_accept_to_relay: false,
    relay_attempts: 0,
    source_nonce: sourceNonce,
    source_payload: serializeSourcePayload(buildSourcePayload(event)),
    order_era: event.orderEra,
    failure_reason_public: failureReasonPublic,
  };
}

function normalizeOutboundEvent(event: OutboundEvent): OrderInput {
  return {
    networkIn: event.networkIn,
    networkOut: event.networkOut,
    tokenIn: new Uint8Array(event.tokenIn),
    tokenOut: new Uint8Array(event.tokenOut),
    fromAddress: new Uint8Array(event.fromAddress),
    toAddress: new Uint8Array(event.toAddress),
    amount: rawWqubicToQu(event.amount),
    relayerFee: rawWqubicToQu(event.relayerFee),
    nonce: new Uint8Array(event.nonce),
    orderEra: event.orderEra,
  };
}

function buildNormalizedOrderFromOverride(
  existing: OracleOrder,
  sourcePayload: SolanaOrderSourcePayloadV1,
  event: OverrideOutboundEvent,
): OrderInput {
  return {
    networkIn: sourcePayload.networkIn,
    networkOut: sourcePayload.networkOut,
    tokenIn: hexToBytes(sourcePayload.tokenIn),
    tokenOut: hexToBytes(sourcePayload.tokenOut),
    fromAddress: hexToBytes(existing.from),
    toAddress: new Uint8Array(event.toAddress),
    amount: BigInt(existing.amount),
    relayerFee: rawWqubicToQu(event.relayerFee),
    nonce: hexToBytes(sourcePayload.nonce),
    orderEra: sourcePayload.orderEra,
  };
}

export function createSolanaOrderHandlers(deps: SolanaOrderDependencies) {
  const {
    ordersRepository,
    signerService,
    logger,
    validation,
    relayerFeeAcceptance,
  } = deps;

  const handleOutboundEvent = async (
    event: OutboundEvent,
    meta?: { signature?: string },
  ) => {
    logger.debug(
      {
        networkIn: event.networkIn,
        networkOut: event.networkOut,
        amount: event.amount.toString(),
        relayerFee: event.relayerFee.toString(),
        nonce: bytesToHex(event.nonce),
        from: bytesToHex(event.fromAddress),
        to: bytesToHex(event.toAddress),
      },
      "Solana outbound event payload",
    );

    if (event.networkOut !== Network.Qubic) {
      logger.warn(
        { networkOut: event.networkOut },
        "Solana outbound event ignored for unsupported destination",
      );
      return;
    }

    const sourceNonce = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (existing) {
      logger.info(
        { orderId: existing.id },
        "Solana outbound order already exists",
      );
      return;
    }

    const signatureSeed = meta?.signature ?? sourceNonce;
    const originTrxHash = meta?.signature ?? sourceNonce;
    const orderId = orderIdFromSignature(signatureSeed);
    const normalized = normalizeOutboundEvent(event);
    const signature = await signerService.signUnlockOrderForQubic(normalized);
    logger.info({ orderId, signature }, "Solana outbound order signed");
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToQubic(
      rawWqubicToQu(event.amount),
      rawWqubicToQu(event.relayerFee),
    );

    const order = createOrderFromOutboundEvent(
      event,
      signature,
      orderId,
      sourceNonce,
      originTrxHash,
      oracleAcceptToRelay,
    );
    await ordersRepository.create(order);
    logger.info(
      {
        orderId,
        oracleAcceptToRelay,
        rawWqubicAmountToQu: rawWqubicToQu(event.amount),
        rawWqubicRelayerFeeToQu: rawWqubicToQu(event.relayerFee),
      },
      "Solana outbound order stored",
    );
  };

  const handleOverrideOutboundEvent = async (
    event: OverrideOutboundEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _meta?: { signature?: string },
  ) => {
    logger.debug(
      {
        relayerFee: event.relayerFee.toString(),
        nonce: bytesToHex(event.nonce),
        to: bytesToHex(event.toAddress),
      },
      "Solana override outbound event payload",
    );
    const sourceNonceHex = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonceHex);
    if (!existing) {
      logger.warn(
        { sourceNonce: sourceNonceHex },
        "Solana override event received for unknown order",
      );
      return;
    }
    if (existing.status === "finalized") {
      logger.info(
        { orderId: existing.id },
        "Solana override event ignored because order is finalized",
      );
      return;
    }
    const sourcePayload = parseSourcePayload(
      existing.source_payload,
      validation,
    );
    if (!sourcePayload) {
      logger.warn(
        { orderId: existing.id },
        "Solana override event ignored because order metadata is missing",
      );
      return;
    }

    const updatedTo = bytesToHex(event.toAddress);
    const updatedRelayerFee = rawWqubicToQu(event.relayerFee).toString();
    const updatedSignature = await signerService.signUnlockOrderForQubic(
      buildNormalizedOrderFromOverride(existing, sourcePayload, event),
    );
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToQubic(
      BigInt(existing.amount),
      rawWqubicToQu(event.relayerFee),
    );

    await ordersRepository.update(existing.id, {
      to: updatedTo,
      relayerFee: updatedRelayerFee,
      signature: updatedSignature,
      oracle_accept_to_relay: oracleAcceptToRelay,
    });
    logger.info({ orderId: existing.id }, "Solana outbound order updated");
  };

  const handleInboundEvent = async (
    event: { nonce: Uint8Array },
    meta?: { signature?: string },
  ) => {
    if (!meta?.signature) {
      logger.warn("Solana inbound event missing transaction signature");
      return;
    }
    const sourceNonceHex = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonceHex);
    if (!existing) {
      logger.warn(
        { sourceNonce: sourceNonceHex },
        "Solana inbound event received for unknown order",
      );
      return;
    }
    if (existing.dest !== "solana") {
      logger.warn(
        { orderId: existing.id, dest: existing.dest },
        "Solana inbound event ignored (order is not Qubic->Solana)",
      );
      return;
    }
    if (existing.status === "finalized") {
      logger.info(
        { orderId: existing.id },
        "Solana inbound event ignored because order is finalized",
      );
      return;
    }
    await ordersRepository.update(existing.id, {
      destination_trx_hash: meta.signature,
      status: "finalized",
    });
    logger.info(
      { orderId: existing.id, destination_trx_hash: meta.signature },
      "Solana inbound order finalized",
    );
  };

  return {
    handleOutboundEvent,
    handleOverrideOutboundEvent,
    handleInboundEvent,
    parseSourcePayload: (payload?: string) =>
      parseSourcePayload(payload, validation),
    serializeSourcePayload,
  };
}
