import { OracleOrder } from "../../indexer/schemas/order.js";
import { type OutboundEvent } from "../../../../clients/js/types/outboundEvent.js";
import { type OverrideOutboundEvent } from "../../../../clients/js/types/overrideOutboundEvent.js";
import { type SolanaOrderToSign, type SignerService } from "../../signer/signer.service.js";
import type { OrdersRepository } from "../../indexer/orders.repository.js";
import {
  bytesToHex,
  hexToBytes,
  toSafeBigInt,
  toSafeNumber,
} from "./bytes.js";
import { randomUUID } from "node:crypto";

export const SOLANA_PROTOCOL_NAME = "qs-bridge";
export const SOLANA_PROTOCOL_VERSION = "1";
export const QUBIC_NETWORK_ID = 1;

type Logger = {
  info: (payload: unknown, message?: string) => void;
  warn: (payload: unknown, message?: string) => void;
  error: (payload: unknown, message?: string) => void;
};

type SolanaOrderDependencies = {
  ordersRepository: OrdersRepository;
  signerService: SignerService;
  config: { SOLANA_BPS_FEE: number };
  logger: Logger;
  contractAddressBytes: Uint8Array;
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

function toSignerPayload(
  normalized: NormalizedOrder,
  contractAddressBytes: Uint8Array
): SolanaOrderToSign {
  return {
    protocolName: SOLANA_PROTOCOL_NAME,
    protocolVersion: SOLANA_PROTOCOL_VERSION,
    contractAddress: contractAddressBytes,
    ...normalized,
  };
}

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
    amount: toSafeNumber(event.amount, "amount"),
    relayerFee: toSafeNumber(event.relayerFee, "relayerFee"),
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
    amount: toSafeBigInt(existing.amount, "amount"),
    relayerFee: event.relayerFee,
    bpsFee,
    nonce: new Uint8Array(event.nonce),
  };
}

export function createSolanaOrderHandlers(deps: SolanaOrderDependencies) {
  const {
    ordersRepository,
    signerService,
    config,
    logger,
    contractAddressBytes,
  } = deps;

  const handleOutboundEvent = async (event: OutboundEvent) => {
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
    const signature = await signerService.signSolanaOrder(
      toSignerPayload(
        normalizeOutboundEvent(event, config.SOLANA_BPS_FEE),
        contractAddressBytes
      )
    );

    const order = createOrderFromOutboundEvent(
      event,
      signature,
      orderId,
      sourceNonce
    );
    order.source_payload = serializeSourcePayload(buildSourcePayload(event));
    await ordersRepository.create(order);
  };

  const handleOverrideOutboundEvent = async (event: OverrideOutboundEvent) => {
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
    const updatedRelayerFee = toSafeNumber(event.relayerFee, "relayerFee");

    const signature = await signerService.signSolanaOrder(
      toSignerPayload(
        normalizeOverrideEvent(
          event,
          existing,
          sourcePayload,
          config.SOLANA_BPS_FEE
        ),
        contractAddressBytes
      )
    );

    await ordersRepository.update(existing.id, {
      to: updatedTo,
      relayerFee: updatedRelayerFee,
      signature,
    });
  };

  return {
    handleOutboundEvent,
    handleOverrideOutboundEvent,
    parseSourcePayload,
    serializeSourcePayload,
  };
}
