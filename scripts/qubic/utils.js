import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";

export const QSB_CONTRACT_INDEX = 27;
export const PROTOCOL_NAME = "QubicBridge";
export const PROTOCOL_VERSION = "1";
export const QUBIC_NETWORK_ID = 1;
export const SOLANA_NETWORK_ID = 2;
export const LOCK_INPUT_TYPE = 1;
export const UNLOCK_INPUT_TYPE = 3;
export const TICK_OFFSET = 5;

export const DEFAULT_NODE_RPC_URL = "http://localhost:41841";
export const DEFAULT_BOB_URL = "http://localhost:40420";

export function resolveNodeRpcUrl() {
  return process.env.QUBIC_BROADCAST_RPC_URL ?? DEFAULT_NODE_RPC_URL;
}

export function resolveBobUrl() {
  return process.env.QUBIC_RPC_URL ?? DEFAULT_BOB_URL;
}

export function resolveQubicKeysPath() {
  return process.env.QUBIC_KEYS ?? null;
}

/** 32-byte LE-encoded destination address for the given contract index. */
export function contractAddressBytes(index = QSB_CONTRACT_INDEX) {
  const addr = new Uint8Array(32);
  let v = index;
  for (let i = 0; i < 4; i++) {
    addr[i] = v & 0xff;
    v >>>= 8;
  }
  return addr;
}

export async function loadQubicKeys(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const keys = JSON.parse(raw);
  if (typeof keys.sKey !== "string" || keys.sKey.length === 0) {
    throw new Error(`${filePath}: missing or empty sKey`);
  }
  return keys;
}

export async function createQubicIdPackage(sKey) {
  const helper = new QubicHelper();
  return helper.createIdPackage(sKey);
}

/**
 * Serializes Lock_input (88 bytes) — matches QSB contract Lock_input struct.
 *
 * Layout (packed, little-endian):
 *   [0..7]    uint64    amount
 *   [8..15]   uint64    relayerFee
 *   [16..79]  uint8[64] toAddress  (ASCII Solana address, zero-padded)
 *   [80..83]  uint32    networkOut
 *   [84..87]  uint32    nonce
 */
export function encodeLockInput(amount, relayerFee, toAddress, networkOut, nonce) {
  const buf = new ArrayBuffer(88);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setBigUint64(0, BigInt(amount), true);
  view.setBigUint64(8, BigInt(relayerFee), true);
  bytes.set(new TextEncoder().encode(toAddress.slice(0, 64)), 16);
  view.setUint32(80, networkOut, true);
  view.setUint32(84, nonce, true);
  return bytes;
}

/**
 * Serializes the Order struct (188 bytes) — matches QSB contract Order struct.
 *
 * Layout (packed, little-endian):
 *   [0..31]    id        fromAddress
 *   [32..63]   id        toAddress
 *   [64..95]   uint8[32] tokenIn
 *   [96..127]  uint8[32] tokenOut
 *   [128..135] uint64    amount
 *   [136..143] uint64    relayerFee
 *   [144..147] uint32    networkIn
 *   [148..151] uint32    networkOut
 *   [152..183] uint8[32] nonce
 *   [184..187] uint32    orderEra
 */
export function encodeOrderStruct(order) {
  const buf = new ArrayBuffer(188);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;
  bytes.set(order.fromAddress, off); off += 32;
  bytes.set(order.toAddress, off); off += 32;
  bytes.set(order.tokenIn, off); off += 32;
  bytes.set(order.tokenOut, off); off += 32;
  view.setBigUint64(off, BigInt(order.amount), true); off += 8;
  view.setBigUint64(off, BigInt(order.relayerFee), true); off += 8;
  view.setUint32(off, order.networkIn, true); off += 4;
  view.setUint32(off, order.networkOut, true); off += 4;
  bytes.set(order.nonce, off); off += 32;
  view.setUint32(off, order.orderEra, true);
  return bytes;
}

/**
 * Serializes QSBOrderMessage (245 bytes) — the K12 hash pre-image for
 * oracle signatures. Matches QSBOrderMessage struct in
 * core-lite/src/contracts/QubicSolanaBridge.h.
 *
 * Layout (packed, little-endian):
 *   [0..3]     uint32    protocolNameLen    (= 11)
 *   [4..19]    uint8[16] protocolName       ("QubicBridge" + 5 zero bytes)
 *   [20..23]   uint32    protocolVersionLen (= 1)
 *   [24]       uint8     protocolVersion    (= 49, ASCII '1')
 *   [25..56]   uint8[32] contractAddress
 *   [57..60]   uint32    networkIn
 *   [61..64]   uint32    networkOut
 *   [65..96]   uint8[32] tokenIn
 *   [97..128]  uint8[32] tokenOut
 *   [129..160] uint8[32] fromAddress
 *   [161..192] uint8[32] toAddress
 *   [193..200] uint64    amount
 *   [201..208] uint64    relayerFee
 *   [209..240] uint8[32] nonce
 *   [241..244] uint32    orderEra
 */
export function encodeQsbOrderMessage(msg) {
  const buf = new ArrayBuffer(245);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const nameBytes = new TextEncoder().encode(msg.protocolName);
  let off = 0;
  view.setUint32(off, nameBytes.length, true); off += 4;
  bytes.set(nameBytes, off); off += 16; // Array<uint8,16>: pad beyond name length
  view.setUint32(off, 1, true); off += 4;
  bytes[off] = msg.protocolVersion.charCodeAt(0); off += 1;
  bytes.set(msg.contractAddress, off); off += 32;
  view.setUint32(off, msg.networkIn, true); off += 4;
  view.setUint32(off, msg.networkOut, true); off += 4;
  bytes.set(msg.tokenIn, off); off += 32;
  bytes.set(msg.tokenOut, off); off += 32;
  bytes.set(msg.fromAddress, off); off += 32;
  bytes.set(msg.toAddress, off); off += 32;
  view.setBigUint64(off, BigInt(msg.amount), true); off += 8;
  view.setBigUint64(off, BigInt(msg.relayerFee), true); off += 8;
  bytes.set(msg.nonce, off); off += 32;
  view.setUint32(off, msg.orderEra, true);
  return bytes;
}

// ── RPC helpers ────────────────────────────────────────────────────────────

export async function getCurrentTick(nodeRpcUrl = resolveNodeRpcUrl()) {
  const res = await fetch(`${nodeRpcUrl}/live/v1/tick-info`);
  if (!res.ok) throw new Error(`tick-info HTTP ${res.status}`);
  const body = await res.json();
  return body.tick;
}

export async function getBalance(nodeRpcUrl, publicId) {
  const res = await fetch(`${nodeRpcUrl}/live/v1/balances/${publicId}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body.balance?.balance ?? null;
}

/** Broadcasts a signed transaction via Bob Node (hex-encoded, captures + forwards). */
export async function broadcastViaBob(bobUrl, txBytes) {
  const hex = Buffer.from(txBytes).toString("hex");
  const res = await fetch(`${bobUrl}/broadcastTransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: hex }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`broadcast failed: HTTP ${res.status} — ${errBody}`);
  }
  return res.json();
}
