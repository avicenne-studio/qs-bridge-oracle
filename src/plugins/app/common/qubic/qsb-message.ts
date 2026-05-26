import { getUtf8Encoder, getBytesEncoder } from "@solana/kit";
import type { BridgeOrderFields } from "../solana/program.js";

/**
 * Serializes a QSBOrderMessage (256 bytes) matching the Qubic contract layout.
 *
 * The C++ compiler inserts alignment padding that must be reproduced exactly:
 *   - 3 bytes padding after contractAddress (align uint32 networkIn to 4)
 *   - 4 bytes padding after toAddress (align uint64 amount to 8)
 *   - 4 bytes trailing padding
 *
 * Layout (natural C++ alignment, little-endian):
 *   [0..3]     uint32    protocolNameLen    (= 11)
 *   [4..19]    uint8[16] protocolName       ("QubicBridge" + 5 zero bytes)
 *   [20..23]   uint32    protocolVersionLen (= 1)
 *   [24]       uint8     protocolVersion    (= 49, ASCII '1')
 *   [25..56]   uint8[32] contractAddress
 *   [57..59]   ---       3 bytes padding
 *   [60..63]   uint32    networkIn
 *   [64..67]   uint32    networkOut
 *   [68..99]   uint8[32] tokenIn
 *   [100..131] uint8[32] tokenOut
 *   [132..163] uint8[32] fromAddress
 *   [164..195] uint8[32] toAddress
 *   [196..199] ---       4 bytes padding
 *   [200..207] uint64    amount
 *   [208..215] uint64    relayerFee
 *   [216..247] uint8[32] nonce
 *   [248..251] uint32    orderEra
 *   [252..255] ---       4 bytes trailing padding
 */
export function serializeQsbOrderMessage(order: BridgeOrderFields): Uint8Array {
  const buf = new ArrayBuffer(256);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const nameBytes = getUtf8Encoder().encode(order.protocolName);
  let off = 0;
  view.setUint32(off, nameBytes.length, true); off += 4;
  bytes.set(nameBytes, off); off += 16;
  view.setUint32(off, 1, true); off += 4;
  bytes[off] = order.protocolVersion.charCodeAt(0); off += 1;
  bytes.set(new Uint8Array(getBytesEncoder().encode(order.contractAddress)), off); off += 32;
  off += 3; // padding: align uint32 networkIn to 4
  view.setUint32(off, order.networkIn, true); off += 4;
  view.setUint32(off, order.networkOut, true); off += 4;
  bytes.set(new Uint8Array(getBytesEncoder().encode(order.tokenIn)), off); off += 32;
  bytes.set(new Uint8Array(getBytesEncoder().encode(order.tokenOut)), off); off += 32;
  bytes.set(new Uint8Array(getBytesEncoder().encode(order.fromAddress)), off); off += 32;
  bytes.set(new Uint8Array(getBytesEncoder().encode(order.toAddress)), off); off += 32;
  off += 4; // padding: align uint64 amount to 8
  view.setBigUint64(off, BigInt(order.amount), true); off += 8;
  view.setBigUint64(off, BigInt(order.relayerFee), true); off += 8;
  bytes.set(new Uint8Array(getBytesEncoder().encode(order.nonce)), off); off += 32;
  view.setUint32(off, order.orderEra, true);
  // [252..255] trailing padding — already zero from ArrayBuffer
  return bytes;
}
