import { type SolanaStoredEvent } from "./schemas/solana-event.js";
import { hexToBytes, toU64BigInt } from "../../common/bytes.js";

export function mapStoredEventToSolanaPayload(event: SolanaStoredEvent) {
  if (event.type === "outbound") {
    const payload = event.payload;
    if ("networkIn" in payload) {
      return {
        type: "outbound" as const,
        event: {
          discriminator: 1,
          networkIn: payload.networkIn,
          networkOut: payload.networkOut,
          tokenIn: hexToBytes(payload.tokenIn),
          tokenOut: hexToBytes(payload.tokenOut),
          fromAddress: hexToBytes(payload.fromAddress),
          toAddress: hexToBytes(payload.toAddress),
          amount: toU64BigInt(payload.amount, "amount"),
          relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
          nonce: hexToBytes(payload.nonce),
        },
      };
    }
  }
  if (event.type === "inbound") {
    const payload = event.payload;
    if ("networkIn" in payload) {
      return {
        type: "inbound" as const,
        event: {
          discriminator: 0,
          networkIn: payload.networkIn,
          networkOut: payload.networkOut,
          tokenIn: hexToBytes(payload.tokenIn),
          tokenOut: hexToBytes(payload.tokenOut),
          fromAddress: hexToBytes(payload.fromAddress),
          toAddress: hexToBytes(payload.toAddress),
          amount: toU64BigInt(payload.amount, "amount"),
          relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
          nonce: hexToBytes(payload.nonce),
        },
      };
    }
  }
  const payload = event.payload;
  return {
    type: "override-outbound" as const,
    event: {
      discriminator: 2,
      toAddress: hexToBytes(payload.toAddress),
      relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
      nonce: hexToBytes(payload.nonce),
    },
  };
}
