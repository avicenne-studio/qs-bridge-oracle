/**
 * Serializes a bridge Order struct (188 bytes) matching the QSB contract layout.
 *
 * Layout (packed, little-endian):
 *   [0..31]     id         fromAddress
 *   [32..63]    id         toAddress
 *   [64..95]    uint8[32]  tokenIn
 *   [96..127]   uint8[32]  tokenOut
 *   [128..135]  uint64     amount
 *   [136..143]  uint64     relayerFee
 *   [144..147]  uint32     networkIn
 *   [148..151]  uint32     networkOut
 *   [152..183]  uint8[32]  nonce
 *   [184..187]  uint32     orderEra
 *
 * This is used in Unlock_input, NOT for signature hashing (which uses QSBOrderMessage).
 */

export const ORDER_STRUCT_SIZE = 188;

export type OrderFields = {
  fromAddress: Uint8Array; // 32 bytes
  toAddress: Uint8Array; // 32 bytes
  tokenIn: Uint8Array; // 32 bytes
  tokenOut: Uint8Array; // 32 bytes
  amount: bigint;
  relayerFee: bigint;
  networkIn: number;
  networkOut: number;
  nonce: Uint8Array; // 32 bytes
  orderEra: number;
};

export function serializeOrderStruct(order: OrderFields): Uint8Array {
  const buf = new ArrayBuffer(ORDER_STRUCT_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;

  bytes.set(order.fromAddress, offset);
  offset += 32;

  bytes.set(order.toAddress, offset);
  offset += 32;

  bytes.set(order.tokenIn, offset);
  offset += 32;

  bytes.set(order.tokenOut, offset);
  offset += 32;

  view.setBigUint64(offset, order.amount, true);
  offset += 8;

  view.setBigUint64(offset, order.relayerFee, true);
  offset += 8;

  view.setUint32(offset, order.networkIn, true);
  offset += 4;

  view.setUint32(offset, order.networkOut, true);
  offset += 4;

  bytes.set(order.nonce, offset);
  offset += 32;

  view.setUint32(offset, order.orderEra, true);

  return bytes;
}

/**
 * Builds Unlock_input: Order (188) + numSignatures (4) + SignatureData[] (96 each)
 *
 * Only the provided signatures are serialized.
 * The contract reads up to numSignatures entries.
 *
 * SignatureData layout:
 *   [0..31]   id (oracle public key)
 *   [32..95]  sint8[64] (signature)
 */
const SIG_DATA_SIZE = 32 + 64; // id + signature per oracle

export function buildUnlockInput(
  order: OrderFields,
  signatures: Array<{ signerPublicKey: Uint8Array; signature: Uint8Array }>,
): Uint8Array {
  const totalSize = ORDER_STRUCT_SIZE + 4 + signatures.length * SIG_DATA_SIZE;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Order struct
  bytes.set(serializeOrderStruct(order), 0);
  let offset = ORDER_STRUCT_SIZE;

  // numSignatures
  view.setUint32(offset, signatures.length, true);
  offset += 4;

  // SignatureData array
  for (const sig of signatures) {
    bytes.set(sig.signerPublicKey, offset);
    offset += 32;
    bytes.set(sig.signature, offset);
    offset += 64;
  }

  return bytes;
}
