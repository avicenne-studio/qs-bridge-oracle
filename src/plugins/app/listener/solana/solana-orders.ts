import { OracleOrder } from "../../indexer/schemas/order.js";
import type { FastifyBaseLogger } from "fastify";
import { type OutboundEvent } from "../../../../clients/js/types/outboundEvent.js";
import { type OverrideOutboundEvent } from "../../../../clients/js/types/overrideOutboundEvent.js";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import {
  bytesToHex,
  hexToBytes,
  toU64BigInt,
} from "./bytes.js";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

export const QUBIC_NETWORK_ID = 1;

type Logger = FastifyBaseLogger;

type SolanaOrderDependencies = {
  ordersRepository: OrdersRepository;
  config: { SOLANA_BPS_FEE: number };
  logger: Logger;
};

type SolanaOrderSourcePayloadV1 = {
  v: 1;
  networkIn: number;
  networkOut: number;
  tokenIn: string;
  tokenOut: string;
  nonce: string;
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

function serializeSourcePayload(payload: SolanaOrderSourcePayloadV1): string {
  return JSON.stringify(payload);
}

function parseSourcePayload(
  payload: string | undefined
): SolanaOrderSourcePayloadV1 | null {
  if (!payload) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload) as Partial<SolanaOrderSourcePayloadV1>;
    if (
      parsed.v !== 1 ||
      typeof parsed.networkIn !== "number" ||
      typeof parsed.networkOut !== "number" ||
      typeof parsed.tokenIn !== "string" ||
      typeof parsed.tokenOut !== "string" ||
      typeof parsed.nonce !== "string"
    ) {
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
  sourceNonce: string
): OracleOrder {
  return {
    id: orderId,
    source: "solana",
    dest: "qubic",
    from: bytesToHex(event.fromAddress),
    to: bytesToHex(event.toAddress),
    amount: event.amount.toString(),
    relayerFee: event.relayerFee.toString(),
    signature,
    status: "ready-for-relay",
    oracle_accept_to_relay: true,
    source_nonce: sourceNonce,
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

function normalizeOverrideEvent(
  event: OverrideOutboundEvent,
  existing: OracleOrder,
  payload: SolanaOrderSourcePayloadV1,
  bpsFee: number
): NormalizedOrder {
  return {
    networkIn: payload.networkIn,
    networkOut: payload.networkOut,
    tokenIn: hexToBytes(payload.tokenIn),
    tokenOut: hexToBytes(payload.tokenOut),
    fromAddress: hexToBytes(existing.from),
    toAddress: new Uint8Array(event.toAddress),
    amount: toU64BigInt(existing.amount, "amount"),
    relayerFee: event.relayerFee,
    bpsFee,
    nonce: new Uint8Array(event.nonce),
  };
}

export function createSolanaOrderHandlers(deps: SolanaOrderDependencies) {
  const { ordersRepository, config, logger } = deps;

  const dummyQubicSignature = (
    normalized: NormalizedOrder,
    orderId: string
  ) => {
    const digest = createHash("sha256")
      .update(normalized.nonce)
      .update(Buffer.from(orderId))
      .digest("hex")
      .slice(0, 16);
    return `dummy-qubic-${orderId}-${digest}`;
  };

  const handleOutboundEvent = async (event: OutboundEvent) => {
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

    const orderId = randomUUID();
    const normalized = normalizeOutboundEvent(event, config.SOLANA_BPS_FEE);
    const signature = dummyQubicSignature(normalized, orderId);
    logger.warn(
      { orderId },
      "Using dummy Qubic signature for outbound order"
    );

    const order = createOrderFromOutboundEvent(
      event,
      signature,
      orderId,
      sourceNonce
    );
    order.source_payload = serializeSourcePayload(buildSourcePayload(event));
    await ordersRepository.create(order);
    logger.info({ orderId }, "Solana outbound order stored");
  };

  const handleOverrideOutboundEvent = async (event: OverrideOutboundEvent) => {
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
        { orderId: sourceNonce },
        "Solana override event received for unknown order"
      );
      return;
    }
    const sourcePayload = parseSourcePayload(existing.source_payload);
    if (!sourcePayload) {
      logger.warn(
        { orderId: existing.id },
        "Solana override event ignored because order metadata is missing"
      );
      return;
    }

    const updatedTo = bytesToHex(event.toAddress);
    const updatedRelayerFee = event.relayerFee.toString();

    const normalized = normalizeOverrideEvent(
      event,
      existing,
      sourcePayload,
      config.SOLANA_BPS_FEE
    );
    const signature = dummyQubicSignature(normalized, existing.id);
    logger.warn(
      { orderId: existing.id },
      "Using dummy Qubic signature for outbound override"
    );

    await ordersRepository.update(existing.id, {
      to: updatedTo,
      relayerFee: updatedRelayerFee,
      signature,
    });
    logger.info({ orderId: existing.id }, "Solana outbound order updated");
  };

  return {
    handleOutboundEvent,
    handleOverrideOutboundEvent,
    parseSourcePayload,
    serializeSourcePayload,
  };
}
