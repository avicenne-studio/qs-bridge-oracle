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
import { PublicKey } from "@solana/web3.js";
import { type SignerService } from "../../signer/signer.service.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../../clients/js/programs/qsBridge.js";
import {
  SolanaOrderSourcePayloadSchema,
  type SolanaOrderSourcePayloadV1,
} from "./schemas/solana-order-source-payload.js";
import { type ValidationService } from "../../common/validation.js";
import type { RelayerFeeAcceptance } from "../../relayer/relayer-fee-acceptance.js";

export const QUBIC_NETWORK_ID = 1;
const PROTOCOL_NAME = "qs-bridge";
const PROTOCOL_VERSION = "1";
const CONTRACT_ADDRESS_BYTES = new PublicKey(
  QS_BRIDGE_PROGRAM_ADDRESS
).toBytes();

type Logger = FastifyBaseLogger;

type SolanaOrderDependencies = {
  ordersRepository: OrdersRepository;
  signerService: SignerService;
  config: { SOLANA_BPS_FEE: number };
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
  bpsFee: number;
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
  bpsFee: number
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
    bpsFee,
    nonce: new Uint8Array(event.nonce),
  };
}

async function signSolanaOrder(
  signerService: SignerService,
  normalized: NormalizedOrder
): Promise<string> {
  return signerService.signSolanaOrder({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: CONTRACT_ADDRESS_BYTES,
    networkIn: normalized.networkIn,
    networkOut: normalized.networkOut,
    tokenIn: normalized.tokenIn,
    tokenOut: normalized.tokenOut,
    fromAddress: normalized.fromAddress,
    toAddress: normalized.toAddress,
    amount: normalized.amount,
    relayerFee: normalized.relayerFee,
    bpsFee: normalized.bpsFee,
    nonce: normalized.nonce,
  });
}

function buildNormalizedOrderFromOverride(
  existing: OracleOrder,
  sourcePayload: SolanaOrderSourcePayloadV1,
  event: OverrideOutboundEvent,
  bpsFee: number
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
    bpsFee,
    nonce: hexToBytes(sourcePayload.nonce),
  };
}

export function createSolanaOrderHandlers(deps: SolanaOrderDependencies) {
  const {
    ordersRepository,
    signerService,
    config,
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
    
    if (event.networkOut !== QUBIC_NETWORK_ID) {
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
    const normalized = normalizeOutboundEvent(event, config.SOLANA_BPS_FEE);
    const signature = await signSolanaOrder(signerService, normalized);
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
    const updatedSignature = await signSolanaOrder(
      signerService,
      buildNormalizedOrderFromOverride(
        existing,
        sourcePayload,
        event,
        config.SOLANA_BPS_FEE
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

  return {
    handleOutboundEvent,
    handleOverrideOutboundEvent,
    parseSourcePayload: (payload?: string) =>
      parseSourcePayload(payload, validation),
    serializeSourcePayload,
  };
}
