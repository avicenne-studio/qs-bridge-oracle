import { OracleOrder } from "../../indexer/schemas/order.js";
import type { FastifyBaseLogger } from "fastify";
import { type OutboundEvent } from "../../../../clients/js/types/outboundEvent.js";
import { type OverrideOutboundEvent } from "../../../../clients/js/types/overrideOutboundEvent.js";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import {
  bytesToHex,
  hexToBytes,
} from "./bytes.js";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { type SignerService } from "../../signer/signer.service.js";
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

type NormalizedOrder = {
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

function serializeSourcePayload(payload: SolanaOrderSourcePayloadV1): string {
  return JSON.stringify(payload);
}

function parseSourcePayload(
  payload: string | undefined,
  validation: ValidationService
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

function buildSourcePayload(
  event: OutboundEvent
): SolanaOrderSourcePayloadV1 {
  return {
    v: 1,
    networkIn: event.networkIn,
    networkOut: event.networkOut,
    tokenIn: bytesToHex(event.tokenIn),
    tokenOut: bytesToHex(event.tokenOut),
    nonce: bytesToHex(event.nonce),
  };
}

function createOrderFromOutboundEvent(
  event: OutboundEvent,
  signature: string,
  orderId: string,
  sourceNonce: string,
  originTrxHash: string,
  oracleAcceptToRelay: boolean
): OracleOrder {
  return {
    id: orderId,
    source: "solana",
    dest: "qubic",
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
  };
}

export function createFailedOrderFromOutboundEvent(
  event: OutboundEvent,
  meta: { signature?: string },
  failureReasonPublic: string
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
    amount: event.amount.toString(),
    relayerFee: event.relayerFee.toString(),
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

function normalizeOutboundEvent(
  event: OutboundEvent,
): NormalizedOrder {
  return {
    networkIn: event.networkIn,
    networkOut: event.networkOut,
    tokenIn: new Uint8Array(event.tokenIn),
    tokenOut: new Uint8Array(event.tokenOut),
    fromAddress: new Uint8Array(event.fromAddress),
    toAddress: new Uint8Array(event.toAddress),
    amount: event.amount,
    relayerFee: event.relayerFee,
    nonce: new Uint8Array(event.nonce),
  };
}

// TODO: Implement real signing for the Qubic contract once its message
// hash format is known. For now return a deterministic placeholder so that
// the order can be stored and later re-signed.
function signOutboundOrder(
  _signerService: SignerService,
  normalized: NormalizedOrder
): string {
  const tag = Buffer.from("qubic-order-placeholder");
  const nonce = Buffer.from(normalized.nonce);
  return createHash("sha256").update(tag).update(nonce).digest("base64");
}

function buildNormalizedOrderFromOverride(
  existing: OracleOrder,
  sourcePayload: SolanaOrderSourcePayloadV1,
  event: OverrideOutboundEvent,
): NormalizedOrder {
  return {
    networkIn: sourcePayload.networkIn,
    networkOut: sourcePayload.networkOut,
    tokenIn: hexToBytes(sourcePayload.tokenIn),
    tokenOut: hexToBytes(sourcePayload.tokenOut),
    fromAddress: hexToBytes(existing.from),
    toAddress: new Uint8Array(event.toAddress),
    amount: BigInt(existing.amount),
    relayerFee: event.relayerFee,
    nonce: hexToBytes(sourcePayload.nonce),
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
    meta?: { signature?: string }
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
      "Solana outbound event payload"
    );
    
    if (event.networkOut !== Network.Qubic) {
      logger.warn(
        { networkOut: event.networkOut },
        "Solana outbound event ignored for unsupported destination"
      );
      return;
    }

    const sourceNonce = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (existing) {
      logger.info({ orderId: existing.id }, "Solana outbound order already exists");
      return;
    }

    const signatureSeed = meta?.signature ?? sourceNonce;
    const originTrxHash = meta?.signature ?? sourceNonce;
    const orderId = orderIdFromSignature(signatureSeed);
    const normalized = normalizeOutboundEvent(event);
    const signature = signOutboundOrder(signerService, normalized);
    logger.info({ orderId, signature }, "Solana outbound order signed");
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToQubic(
      event.amount,
      event.relayerFee
    );

    const order = createOrderFromOutboundEvent(
      event,
      signature,
      orderId,
      sourceNonce,
      originTrxHash,
      oracleAcceptToRelay
    );
    order.source_payload = serializeSourcePayload(buildSourcePayload(event));
    await ordersRepository.create(order);
    logger.info({ orderId }, "Solana outbound order stored");
  };

  const handleOverrideOutboundEvent = async (
    event: OverrideOutboundEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _meta?: { signature?: string }
  ) => {
    logger.debug(
      {
        relayerFee: event.relayerFee.toString(),
        nonce: bytesToHex(event.nonce),
        to: bytesToHex(event.toAddress),
      },
      "Solana override outbound event payload"
    );
    const sourceNonce = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (!existing) {
      logger.warn(
        { sourceNonce },
        "Solana override event received for unknown order"
      );
      return;
    }
    if (existing.status === "finalized") {
      logger.info(
        { orderId: existing.id },
        "Solana override event ignored because order is finalized"
      );
      return;
    }
    const sourcePayload = parseSourcePayload(
      existing.source_payload,
      validation
    );
    if (!sourcePayload) {
      logger.warn(
        { orderId: existing.id },
        "Solana override event ignored because order metadata is missing"
      );
      return;
    }

    const updatedTo = bytesToHex(event.toAddress);
    const updatedRelayerFee = event.relayerFee.toString();
    const updatedSignature = signOutboundOrder(
      signerService,
      buildNormalizedOrderFromOverride(
        existing,
        sourcePayload,
        event,
      )
    );
    const oracleAcceptToRelay = relayerFeeAcceptance.acceptRelayToQubic(
      BigInt(existing.amount),
      event.relayerFee
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
    meta?: { signature?: string }
  ) => {
    if (!meta?.signature) {
      logger.warn("Solana inbound event missing transaction signature");
      return;
    }
    const sourceNonce = bytesToHex(event.nonce);
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (!existing) {
      logger.warn(
        { sourceNonce },
        "Solana inbound event received for unknown order"
      );
      return;
    }
    if (existing.dest !== "solana") {
      logger.warn(
        { orderId: existing.id, dest: existing.dest },
        "Solana inbound event ignored (order is not Qubic->Solana)"
      );
      return;
    }
    if (existing.status === "finalized") {
      logger.info(
        { orderId: existing.id },
        "Solana inbound event ignored because order is finalized"
      );
      return;
    }
    await ordersRepository.update(existing.id, {
      destination_trx_hash: meta.signature,
      status: "finalized",
    });
    logger.info(
      { orderId: existing.id, destination_trx_hash: meta.signature },
      "Solana inbound order finalized"
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
