import {
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  getBytesEncoder,
} from "@solana/kit";
import type { BridgeOrderFields } from "../solana/program.js";

/**
 * Serializes a QSBOrderMessage (245 bytes) matching the Qubic contract layout.
 *
 * Identical to serializeBridgeOrder EXCEPT:
 *   - protocolName is padded to 16 bytes (Array<uint8, 16> in Qubic QPI)
 *   - protocolVersion stays 1 byte (Array<uint8, 1>)
 *   - Total: 245 bytes instead of 240
 *
 * Used for K12 hashing + SchnorrQ signature verification on the Qubic chain.
 * The Solana path continues to use serializeBridgeOrder (240 bytes, SHA256).
 */
const PROTOCOL_NAME_PADDED_SIZE = 16;

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function encodePaddedString(value: string, paddedSize: number): Uint8Array {
  const stringBytes = getUtf8Encoder().encode(value);
  const lengthBytes = new Uint8Array(getU32Encoder().encode(stringBytes.length));
  const padded = new Uint8Array(paddedSize);
  padded.set(stringBytes);
  return concatBytes([lengthBytes, padded]);
}

function encodeString(value: string): Uint8Array {
  const stringBytes = getUtf8Encoder().encode(value);
  const lengthBytes = new Uint8Array(getU32Encoder().encode(stringBytes.length));
  return concatBytes([lengthBytes, new Uint8Array(stringBytes)]);
}

export function serializeQsbOrderMessage(order: BridgeOrderFields): Uint8Array {
  return concatBytes([
    encodePaddedString(order.protocolName, PROTOCOL_NAME_PADDED_SIZE),
    encodeString(order.protocolVersion),
    new Uint8Array(getBytesEncoder().encode(order.contractAddress)),
    new Uint8Array(getU32Encoder().encode(order.networkIn)),
    new Uint8Array(getU32Encoder().encode(order.networkOut)),
    new Uint8Array(getBytesEncoder().encode(order.tokenIn)),
    new Uint8Array(getBytesEncoder().encode(order.tokenOut)),
    new Uint8Array(getBytesEncoder().encode(order.fromAddress)),
    new Uint8Array(getBytesEncoder().encode(order.toAddress)),
    new Uint8Array(getU64Encoder().encode(order.amount)),
    new Uint8Array(getU64Encoder().encode(order.relayerFee)),
    new Uint8Array(getBytesEncoder().encode(order.nonce)),
    new Uint8Array(getU32Encoder().encode(order.orderEra)),
  ]);
}
