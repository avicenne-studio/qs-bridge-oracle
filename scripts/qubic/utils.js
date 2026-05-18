import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";

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
 * Serializes QSBOrderMessage (256 bytes) — the K12 hash pre-image for
 * oracle signatures. Matches sizeof(QSBOrderMessage) in
 * core-lite/src/contracts/QubicSolanaBridge.h with natural C++ alignment.
 *
 * The C++ compiler inserts 3 bytes of padding after contractAddress (to
 * align uint32 networkIn to 4 bytes) and 4 bytes after toAddress (to align
 * uint64 amount to 8 bytes), plus 4 bytes of trailing struct padding, making
 * the actual sizeof 256 instead of the "logical" 245.
 *
 * Layout (natural alignment, little-endian):
 *   [0..3]     uint32    protocolNameLen    (= 11)
 *   [4..19]    uint8[16] protocolName       ("QubicBridge" + 5 zero bytes)
 *   [20..23]   uint32    protocolVersionLen (= 1)
 *   [24]       uint8     protocolVersion    (= 49, ASCII '1')
 *   [25..56]   uint8[32] contractAddress
 *   [57..59]   ---       3 bytes padding (align uint32 to 4)
 *   [60..63]   uint32    networkIn
 *   [64..67]   uint32    networkOut
 *   [68..99]   uint8[32] tokenIn
 *   [100..131] uint8[32] tokenOut
 *   [132..163] uint8[32] fromAddress
 *   [164..195] uint8[32] toAddress
 *   [196..199] ---       4 bytes padding (align uint64 to 8)
 *   [200..207] uint64    amount
 *   [208..215] uint64    relayerFee
 *   [216..247] uint8[32] nonce
 *   [248..251] uint32    orderEra
 *   [252..255] ---       4 bytes trailing padding
 */
export function encodeQsbOrderMessage(msg) {
  const buf = new ArrayBuffer(256);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const nameBytes = new TextEncoder().encode(msg.protocolName);
  let off = 0;
  view.setUint32(off, nameBytes.length, true); off += 4;
  bytes.set(nameBytes, off); off += 16; // Array<uint8,16>: pad beyond name length
  view.setUint32(off, 1, true); off += 4;
  bytes[off] = msg.protocolVersion.charCodeAt(0); off += 1;
  bytes.set(msg.contractAddress, off); off += 32;
  off += 3; // padding: align uint32 networkIn to 4 bytes
  view.setUint32(off, msg.networkIn, true); off += 4;
  view.setUint32(off, msg.networkOut, true); off += 4;
  bytes.set(msg.tokenIn, off); off += 32;
  bytes.set(msg.tokenOut, off); off += 32;
  bytes.set(msg.fromAddress, off); off += 32;
  bytes.set(msg.toAddress, off); off += 32;
  off += 4; // padding: align uint64 amount to 8 bytes
  view.setBigUint64(off, BigInt(msg.amount), true); off += 8;
  view.setBigUint64(off, BigInt(msg.relayerFee), true); off += 8;
  bytes.set(msg.nonce, off); off += 32;
  view.setUint32(off, msg.orderEra, true);
  // [252..255] trailing padding (zeros, already zeroed by ArrayBuffer)
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

// ── Script helpers ─────────────────────────────────────────────────────────

/** Load QUBIC_KEYS and derive publicKey/publicId; exit with an error if not set. */
export async function requireQubicKeys(errorMsg = "QUBIC_KEYS env var must point to the keys file.") {
  const keysPath = resolveQubicKeysPath();
  if (!keysPath) {
    console.error(errorMsg);
    process.exit(1);
  }
  const { sKey: seed } = await loadQubicKeys(keysPath);
  const { publicKey, publicId } = await createQubicIdPackage(seed);
  return { seed, publicKey, publicId };
}

/**
 * Build a QSB contract transaction, broadcast it via Bob Node, and log TX ID + tick.
 * Pass `silent: true` to suppress the TX ID / tick log lines.
 * Returns { txId, tick, targetTick, result }.
 */
export async function buildAndBroadcastTx({
  seed,
  publicKey,
  inputType,
  inputBytes = null,
  amount = 0,
  nodeRpcUrl,
  bobUrl,
  silent = false,
}) {
  const tick = await getCurrentTick(nodeRpcUrl);
  if (tick === 0) { console.error("Node down (tick=0)"); process.exit(1); }
  const targetTick = tick + TICK_OFFSET;

  const dest = new PublicKey(contractAddressBytes());
  let tx = new QubicTransaction()
    .setSourcePublicKey(new PublicKey(publicKey))
    .setDestinationPublicKey(dest)
    .setAmount(new Long(amount))
    .setTick(targetTick)
    .setInputType(inputType)
    .setInputSize(inputBytes?.length ?? 0);

  if (inputBytes?.length) {
    const dynPayload = new DynamicPayload(inputBytes.length);
    dynPayload.setPayload(inputBytes);
    tx = tx.setPayload(dynPayload);
  }

  const builtTx = await tx.build(seed);
  const txId = tx.getId();

  if (!silent) {
    console.log(`\n  TX ID  : ${txId}`);
    console.log(`  Tick   : ${tick} → ${targetTick}`);
  }

  const result = await broadcastViaBob(bobUrl, builtTx);
  return { txId, tick, targetTick, result };
}

/** Animated dot-poll until the current tick reaches targetTick. */
export async function waitForTick(nodeRpcUrl, targetTick, { timeout = 90_000, interval = 3000 } = {}) {
  process.stdout.write("  Waiting...");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if ((await getCurrentTick(nodeRpcUrl)) >= targetTick) break;
    process.stdout.write(".");
  }
  process.stdout.write("\n");
}

/**
 * Animated dot-poll: call check() up to maxRetries times, stopping when it returns truthy.
 * Returns the final value returned by check().
 */
export async function pollUntil(check, { maxRetries = 10, interval = 1500 } = {}) {
  process.stdout.write("  Verifying");
  let result;
  for (let i = 0; i < maxRetries; i++) {
    await new Promise((r) => setTimeout(r, interval));
    result = await check();
    if (result) break;
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return result;
}

// ── Oracle signing helpers ─────────────────────────────────────────────────

/**
 * Lazy-load the Qubic WASM crypto module (SchnorrQ + K12).
 * Cached after first call; the dynamic import is module-level cached by Node.
 */
let _qubicCryptoCache = null;
async function getQubicCrypto() {
  if (!_qubicCryptoCache) {
    const mod = await import("@qubic-lib/qubic-ts-library/dist/index.js");
    _qubicCryptoCache = await mod.default.default.crypto;
  }
  return _qubicCryptoCache;
}

/**
 * Compute the canonical QSB order hash off-chain.
 *
 * Pre-image: 245-byte QSBOrderMessage → K12 → 32-byte digest (= OrderHash).
 * Result matches on-chain FUNC_COMPUTE_ORDER_HASH.
 *
 * @param {object} order  Same shape as encodeOrderStruct input.
 * @returns {Promise<Uint8Array>} 32-byte order hash.
 */
export async function computeQsbOrderHashOffchain(order) {
  const msgBytes = encodeQsbOrderMessage({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: contractAddressBytes(),
    networkIn: order.networkIn,
    networkOut: order.networkOut,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    fromAddress: order.fromAddress,
    toAddress: order.toAddress,
    amount: BigInt(order.amount),
    relayerFee: BigInt(order.relayerFee),
    nonce: order.nonce,
    orderEra: order.orderEra,
  });
  const { K12 } = await getQubicCrypto();
  const digest = new Uint8Array(32);
  K12(msgBytes, digest, 32);
  return digest;
}

/**
 * Sign a QSB Order with a single oracle key (SchnorrQ over K12 digest).
 *
 * Flow: K12(QSBOrderMessage, 32) → digest → schnorrq.sign(sk, pk, digest)
 * Matches qpi.signatureValidity(signer, digest, signature) in the contract.
 *
 * @param {object} order  Same shape as encodeOrderStruct input.
 * @param {string} sKey   55-char Qubic seed (oracle's private seed).
 * @returns {Promise<{signerPublicKey: Uint8Array, signature: Uint8Array}>}
 */
export async function signQsbOrder(order, sKey) {
  const msgBytes = encodeQsbOrderMessage({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: contractAddressBytes(),
    networkIn: order.networkIn,
    networkOut: order.networkOut,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    fromAddress: order.fromAddress,
    toAddress: order.toAddress,
    amount: BigInt(order.amount),
    relayerFee: BigInt(order.relayerFee),
    nonce: order.nonce,
    orderEra: order.orderEra,
  });
  const helper = new QubicHelper();
  const { privateKey, publicKey } = await helper.createIdPackage(sKey);
  const { schnorrq, K12 } = await getQubicCrypto();
  const digest = new Uint8Array(32);
  K12(msgBytes, digest, 32);
  const signature = schnorrq.sign(privateKey, publicKey, digest);
  return {
    signerPublicKey: new Uint8Array(publicKey),
    signature: new Uint8Array(signature),
  };
}

/**
 * Encode Unlock_input matching sizeof(Unlock_input) C++ layout (natural alignment).
 *
 * sizeof(Order) = 192 (188 bytes data + 4 bytes trailing padding for id align-8).
 * numSignatures (uint32) sits at offset 192.
 * 4 bytes of padding follow to align Array<SignatureData,64> to 8 bytes.
 * SignatureData entries (id:32 + sig:64 = 96 bytes each) start at offset 200.
 *
 * Layout:
 *   [0..187]   Order struct data (encodeOrderStruct)
 *   [188..191] 4 bytes trailing padding (zeros)
 *   [192..195] uint32 numSignatures LE
 *   [196..199] 4 bytes padding (zeros, align Array<SignatureData,64> to 8)
 *   [200..]    SignatureData entries: id(32) + sig(64) each
 *
 * @param {object}   order       Same shape as encodeOrderStruct input.
 * @param {Array<{signerPublicKey: Uint8Array, signature: Uint8Array}>} signatures
 * @returns {Uint8Array}
 */
export function encodeUnlockInput(order, signatures) {
  const SIG_ENTRY_SIZE = 96;
  const SIG_START = 200;
  const buf = new ArrayBuffer(SIG_START + signatures.length * SIG_ENTRY_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(encodeOrderStruct(order), 0);
  // [188..191] trailing padding of Order — already zero from ArrayBuffer
  view.setUint32(192, signatures.length, true);
  // [196..199] padding — already zero
  let offset = SIG_START;
  for (const sig of signatures) {
    bytes.set(sig.signerPublicKey, offset);
    offset += 32;
    bytes.set(sig.signature, offset);
    offset += 64;
  }
  return bytes;
}
