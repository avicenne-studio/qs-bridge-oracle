import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";

export const QSB_CONTRACT_INDEX = 28;
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

// ── View function numbers ──────────────────────────────────────────────────

export const FUNC_GET_CONFIG = 1;
export const FUNC_IS_ORACLE = 2;
export const FUNC_IS_PAUSER = 3;
export const FUNC_GET_LOCKED_ORDER = 4;
export const FUNC_IS_ORDER_FILLED = 5;
export const FUNC_COMPUTE_ORDER_HASH = 6;
export const FUNC_GET_ORACLES = 7;
export const FUNC_GET_PAUSERS = 8;
export const FUNC_GET_LOCKED_ORDERS = 9;
export const FUNC_GET_FILLED_ORDERS = 10;

// ── Identity helpers ───────────────────────────────────────────────────────

/** Convert a 60-char Qubic public ID string to a 32-byte Uint8Array (LE). */
export function qubicIdToBytes(s) {
  const str = s.toUpperCase().trim();
  const len = str.length;
  const CHAR_A = "A".charCodeAt(0);
  const segmentLength = len === 60 ? 14 : Math.floor(len / 4);
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    let n = 0n;
    for (let j = segmentLength - 1; j >= 0; j--) {
      n = n * 26n + BigInt(str.charCodeAt(i * segmentLength + j) - CHAR_A);
    }
    view.setBigUint64(i * 8, n, true);
  }
  return out;
}

/** Convert a 32-byte public key to a Qubic public ID string (async, requires K12 checksum). */
export async function bytesToQubicId(bytes) {
  const helper = new QubicHelper();
  return helper.getIdentity(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

// ── Smart-contract query helper ────────────────────────────────────────────

/**
 * Query a contract view function via Bob Node POST /querySmartContract.
 * Automatically retries on 202-pending responses (up to maxRetries × 300 ms).
 * Returns the raw response as a Node.js Buffer.
 */
export async function queryContractFunction(
  bobUrl,
  scIndex,
  funcNumber,
  inputBytes,
  maxRetries = 20,
) {
  const nonce = (Math.random() * 0xffffffff) >>> 0;
  const data = Buffer.from(inputBytes ?? new Uint8Array(0)).toString("hex");
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${bobUrl}/querySmartContract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, scIndex, funcNumber, data }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`querySmartContract HTTP ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body.error === "pending") continue;
    if (typeof body.data !== "string")
      throw new Error(`querySmartContract: unexpected response: ${JSON.stringify(body)}`);
    return Buffer.from(body.data, "hex");
  }
  throw new Error(`querySmartContract func=${funcNumber}: still pending after ${maxRetries} retries`);
}

// ── Input encoders ─────────────────────────────────────────────────────────

/** Encode GetLockedOrder_input (4 bytes): uint32 nonce LE. */
export function encodeGetLockedOrderInput(nonce) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(nonce >>> 0, 0);
  return buf;
}

/** Encode GetLockedOrders_input / GetFilledOrders_input (8 bytes): offset + limit LE. */
export function encodePaginationInput(offset, limit) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(offset >>> 0, 0);
  buf.writeUInt32LE(limit >>> 0, 4);
  return buf;
}

// ── Output decoders ────────────────────────────────────────────────────────

/**
 * Decode GetConfig_output (120 bytes).
 *
 * Layout (packed, natural alignment, LE):
 *   [0..31]    id    admin
 *   [32..63]   id    protocolFeeRecipient
 *   [64..95]   id    oracleFeeRecipient
 *   [96..99]   u32   bpsFee
 *   [100..103] u32   protocolFee
 *   [104..107] u32   oracleCount
 *   [108..111] u32   pauserCount
 *   [112]      u8    oracleThreshold
 *   [113]      bit   paused  (char, 1 byte)
 *   [114..115] --    padding (u32 alignment)
 *   [116..119] u32   orderEra
 */
export function decodeGetConfigOutput(buf) {
  return {
    admin: buf.slice(0, 32),
    protocolFeeRecipient: buf.slice(32, 64),
    oracleFeeRecipient: buf.slice(64, 96),
    bpsFee: buf.readUInt32LE(96),
    protocolFee: buf.readUInt32LE(100),
    oracleCount: buf.readUInt32LE(104),
    pauserCount: buf.readUInt32LE(108),
    oracleThreshold: buf.readUInt8(112),
    paused: buf.readUInt8(113) !== 0,
    orderEra: buf.readUInt32LE(116),
  };
}

/**
 * Decode a LockedOrderEntry (168 bytes) at `offset` within `buf`.
 *
 * Layout:
 *   [+0..+31]   id        sender
 *   [+32..+39]  u64       amount
 *   [+40..+47]  u64       relayerFee
 *   [+48..+51]  u32       networkOut
 *   [+52..+55]  u32       nonce
 *   [+56..+119] u8[64]    toAddress
 *   [+120..+151] u8[32]   orderHash
 *   [+152..+155] u32      lockEpoch
 *   [+156..+159] u32      orderEra
 *   [+160]      bit       active  (char, 1 byte)
 *   [+161..+167] --       padding (id/u64 alignment)
 */
export function decodeLockedOrderEntry(buf, offset = 0) {
  return {
    sender: buf.slice(offset, offset + 32),
    amount: buf.readBigUInt64LE(offset + 32),
    relayerFee: buf.readBigUInt64LE(offset + 40),
    networkOut: buf.readUInt32LE(offset + 48),
    nonce: buf.readUInt32LE(offset + 52),
    toAddress: buf.slice(offset + 56, offset + 120),
    orderHash: buf.slice(offset + 120, offset + 152),
    lockEpoch: buf.readUInt32LE(offset + 152),
    orderEra: buf.readUInt32LE(offset + 156),
    active: buf.readUInt8(offset + 160) !== 0,
  };
}

/**
 * Decode GetLockedOrder_output (176 bytes).
 *
 * Layout: bit(1) + pad(7) + LockedOrderEntry(168)
 */
export function decodeGetLockedOrderOutput(buf) {
  return {
    exists: buf.readUInt8(0) !== 0,
    order: decodeLockedOrderEntry(buf, 8),
  };
}

/**
 * Decode GetOracles_output (2056 bytes) or GetPausers_output (1032 bytes).
 *
 * Layout: u32 count + pad(4) + Array<id, N>  (id has 8-byte alignment)
 */
export function decodeIdArrayOutput(buf) {
  const count = buf.readUInt32LE(0);
  const accounts = [];
  for (let i = 0; i < count; i++) {
    accounts.push(buf.slice(8 + i * 32, 8 + (i + 1) * 32));
  }
  return { count, accounts };
}

/**
 * Decode GetLockedOrders_output (10760 bytes).
 *
 * Layout: u32 totalActive + u32 returned + Array<LockedOrderEntry(168), 64>
 */
export function decodeGetLockedOrdersOutput(buf) {
  const totalActive = buf.readUInt32LE(0);
  const returned = buf.readUInt32LE(4);
  const entries = [];
  for (let i = 0; i < returned; i++) {
    entries.push(decodeLockedOrderEntry(buf, 8 + i * 168));
  }
  return { totalActive, returned, entries };
}

/**
 * Decode GetFilledOrders_output (2056 bytes).
 *
 * Layout: u32 totalActive + u32 returned + Array<OrderHash(32), 64>
 */
export function decodeGetFilledOrdersOutput(buf) {
  const totalActive = buf.readUInt32LE(0);
  const returned = buf.readUInt32LE(4);
  const hashes = [];
  for (let i = 0; i < returned; i++) {
    hashes.push(buf.slice(8 + i * 32, 8 + (i + 1) * 32));
  }
  return { totalActive, returned, hashes };
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
