/**
 * Qubic script utilities
 * Shared constants, RPC helpers, Bob Node helpers, and QPI struct encoders.
 */

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import process from "node:process";
import { QubicHelper as _QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";

// K12 + SchnorrQ from built-in WASM crypto (resolves blocker T1.3)
const _require = createRequire(import.meta.url);
const _cryptoDefault = _require("@qubic-lib/qubic-ts-library/dist/crypto/index.js");
const _cryptoLib = (_cryptoDefault.default ?? _cryptoDefault) ;
// _cryptoLib resolves to Promise<{ K12, schnorrq }> — awaited at call site

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

export const QUBIC_RPC_URL =
  process.env.QUBIC_RPC_URL ?? "http://95.216.34.251:41841";

// Bob Node (indexer) base URL
export const QUBIC_BOB_URL =
  process.env.QUBIC_BOB_URL ?? "http://95.216.34.251:40420";

export const CONTRACT_INDEX = Number(
  process.env.QUBIC_CONTRACT_INDEX ?? "24"
);

// Contract index 24 address — deterministic: first 4 bytes = uint32LE(24), rest zeros.
// Verified by round-trip with qubicIdToBytes. Override via env var if needed.
export const CONTRACT_ADDRESS =
  process.env.QUBIC_CONTRACT_ADDRESS ??
  "YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// How many ticks in the future to target (Qubic requires future tick)
export const TICK_OFFSET = Number(process.env.QUBIC_TICK_OFFSET ?? "10");

// ─────────────────────────────────────────────────────────────────────────────
// PROCEDURE & FUNCTION IDS
// ─────────────────────────────────────────────────────────────────────────────

export const PROCEDURE_IDS = {
  Lock: 1,
  OverrideLock: 2,
  Unlock: 3,
  CancelLock: 4,
  TransferAdmin: 10,
  EditOracleThreshold: 11,
  AddRole: 12,
  RemoveRole: 13,
  Pause: 14,
  Unpause: 15,
  EditFeeParameters: 16,
};

export const FUNCTION_IDS = {
  GetConfig: 1,
  IsOracle: 2,
  IsPauser: 3,
  GetLockedOrder: 4,
  IsOrderFilled: 5,
  ComputeOrderHash: 6,
  GetOracles: 7,
  GetPausers: 8,
  GetLockedOrders: 9,
  GetFilledOrders: 10,
};

export const ROLE = { Oracle: 1, Pauser: 2 };

export const LOG_TYPE = {
  Lock: 1,
  OverrideLock: 2,
  Unlock: 3,
  Paused: 4,
  Unpaused: 5,
  AdminTransferred: 6,
  ThresholdUpdated: 7,
  RoleGranted: 8,
  RoleRevoked: 9,
  FeeParametersUpdated: 10,
  CancelLock: 11,
};

// ─────────────────────────────────────────────────────────────────────────────
// QUBIC RPC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch current tick info from the Qubic RPC.
 * Returns { tick, epoch, ... }
 */
export async function fetchTickInfo(rpcUrl = QUBIC_RPC_URL) {
  const res = await fetch(`${rpcUrl}/live/v1/tick-info`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tick-info failed [${res.status}]: ${body}`);
  }
  return res.json();
}

export async function fetchCurrentTick(rpcUrl = QUBIC_RPC_URL) {
  const info = await fetchTickInfo(rpcUrl);
  const tick = info.tick ?? info.currentTick;
  if (tick == null) throw new Error("Could not parse tick from tick-info response");
  return Number(tick);
}

/**
 * Broadcast a signed transaction to the Qubic network via testnet RPC.
 * @param {Uint8Array} signedBytes - the signed transaction bytes
 */
export async function broadcastTx(signedBytes, rpcUrl = QUBIC_RPC_URL) {
  const encodedTransaction = Buffer.from(signedBytes).toString("base64");
  const res = await fetch(`${rpcUrl}/live/v1/broadcast-transaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ encodedTransaction }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`broadcast failed [${res.status}]: ${body}`);
  }
  return res.json().catch(() => {
    logSection("broadcastTx", "Warning: could not parse broadcast response as JSON");
  });
}

/**
 * Call a read function (querySmartContract) on the contract.
 * [BLOCKED: S6] Confirm querySmartContract endpoint is supported on this testnet RPC.
 * @param {number} functionId - one of FUNCTION_IDS values
 * @param {Buffer|Uint8Array} inputBytes - encoded input struct
 */
export async function querySmartContract(
  functionId,
  inputBytes = Buffer.alloc(0),
  rpcUrl = QUBIC_RPC_URL
) {
  const requestData = Buffer.from(inputBytes).toString("base64");
  const res = await fetch(`${rpcUrl}/live/v1/querySmartContract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contractIndex: CONTRACT_INDEX,
      inputType: functionId,
      inputSize: inputBytes.length,
      requestData,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`querySmartContract failed [${res.status}]: ${body}`);
  }
  const json = await res.json();
  // Response shape: { responseData: "<base64>" }
  return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOB NODE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query Bob Node logs using /findLog.
 * The exact response schema is Bob-specific and may evolve.
 */
export async function findLogs(
  {
    scIndex,
    fromTick,
    toTick,
    logType = 0,
    topic1 = "",
    topic2 = "",
    topic3 = "",
  },
  bobUrl = QUBIC_BOB_URL
) {
  const res = await fetch(`${bobUrl}/findLog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scIndex,
      fromTick,
      toTick,
      logType,
      topic1,
      topic2,
      topic3,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`findLog failed [${res.status}]: ${body}`);
  }
  const json = await res.json().catch(() => ({}));
  if (json?.ok === false) {
    throw new Error(`findLog error: ${json.error ?? "unknown error"}`);
  }
  return json;
}

/**
 * Fetch a transaction receipt by hash from the Bob Node.
 */
export async function getTxByHash(txHash, bobUrl = QUBIC_BOB_URL) {
  const res = await fetch(`${bobUrl}/tx/${txHash}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`getTxByHash failed [${res.status}]: ${body}`);
  }
  const json = await res.json().catch(() => ({}));
  if (json?.ok === false) {
    throw new Error(`getTxByHash error: ${json.error ?? "unknown error"}`);
  }
  return json;
}


// ─────────────────────────────────────────────────────────────────────────────
// QUBIC ID ENCODING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Qubic ID string (uppercase letters, 48–60 chars) to 32 bytes.
 * Same algorithm as oracle/src/plugins/app/common/qubic/encoding.ts
 */
export function qubicIdToBytes(s) {
  const str = s.toUpperCase();
  const len = str.length;
  // Qubic public IDs are 60 chars: 56 payload + 4 checksum.
  // Decode only the 56 payload chars into 4 × 14-base26 segments.
  const segmentLength =
    len >= 56 ? 14 : len === 52 ? 13 : 12;
  const bytes = Buffer.alloc(32, 0);
  for (let i = 0; i < 4; i++) {
    let val = 0n;
    for (let j = segmentLength - 1; j >= 0; j--) {
      const code = BigInt(str.charCodeAt(i * segmentLength + j) - 65); // 'A' = 65
      val = val * 26n + code;
    }
    bytes.writeBigUInt64LE(val, i * 8);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// QPI STRUCT BINARY ENCODERS
// ─────────────────────────────────────────────────────────────────────────────
// [BLOCKED: S1] All byte layouts below are based on the contract ABI spec in
// implementation-plan.md. Seeker must confirm exact field sizes, ordering,
// and alignment/padding rules before these can be trusted.

function encodeU8(value) {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(value >>> 0, 0);
  return buf;
}

function encodeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function encodeU64LE(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}


/**
 * Encode the Order struct (112 bytes).
 * Layout (confirmed from QubicSolanaBridge.h):
 *   fromAddress (32) | toAddress (32) | tokenIn (8/uint64) | tokenOut (8/uint64) |
 *   amount (8) | relayerFee (8) | destinationChainId (4) |
 *   networkIn (4) | networkOut (4) | nonce (4)
 */
export function encodeOrder({
  fromAddress,
  toAddress,
  tokenIn = 0n,
  tokenOut = 0n,
  amount,
  relayerFee,
  destinationChainId,
  networkIn = 0,
  networkOut,
  nonce,
}) {
  const fromBuf =
    typeof fromAddress === "string"
      ? qubicIdToBytes(fromAddress)
      : Buffer.from(fromAddress);
  const toBuf =
    typeof toAddress === "string"
      ? qubicIdToBytes(toAddress)
      : Buffer.from(toAddress);

  return Buffer.concat([
    fromBuf,
    toBuf,
    encodeU64LE(BigInt(tokenIn)),
    encodeU64LE(BigInt(tokenOut)),
    encodeU64LE(BigInt(amount)),
    encodeU64LE(BigInt(relayerFee)),
    encodeU32LE(destinationChainId ?? networkOut),
    encodeU32LE(networkIn),
    encodeU32LE(networkOut),
    encodeU32LE(nonce),
  ]);
}

/**
 * Encode LockInput (procedure 1) — 84 bytes.
 * Layout: amount(8) | relayerFee(8) | toAddress(64) | networkOut(4) | nonce(4)
 *
 * toAddress is the 64-byte off-chain destination (e.g. Solana address zero-padded).
 */
export function encodeLockInput({ amount, relayerFee, toAddress, networkOut, nonce }) {
  const toAddrBuf = Buffer.isBuffer(toAddress)
    ? toAddress
    : Buffer.from(toAddress);
  if (toAddrBuf.length !== 64) {
    throw new Error(
      `toAddress must be 64 bytes, got ${toAddrBuf.length}. Zero-pad your destination address.`
    );
  }
  return Buffer.concat([
    encodeU64LE(BigInt(amount)),
    encodeU64LE(BigInt(relayerFee)),
    toAddrBuf,
    encodeU32LE(networkOut),
    encodeU32LE(nonce),
  ]);
}

/**
 * Encode OverrideLockInput (procedure 2) — 76 bytes.
 * Layout: toAddress(64) | relayerFee(8) | nonce(4)
 */
export function encodeOverrideLockInput({ toAddress, relayerFee, nonce }) {
  const toAddrBuf = Buffer.isBuffer(toAddress)
    ? toAddress
    : Buffer.from(toAddress);
  if (toAddrBuf.length !== 64) {
    throw new Error(`toAddress must be 64 bytes, got ${toAddrBuf.length}.`);
  }
  return Buffer.concat([
    toAddrBuf,
    encodeU64LE(BigInt(relayerFee)),
    encodeU32LE(nonce),
  ]);
}

/**
 * Encode CancelLockInput (procedure 4) — 4 bytes.
 * Layout: nonce(4)
 */
export function encodeCancelLockInput({ nonce }) {
  return encodeU32LE(nonce);
}

/**
 * Encode AddRoleInput / RemoveRoleInput (procedures 12 & 13) — 33 bytes.
 * Layout: account(32) | role(1)
 * [BLOCKED: S1] Confirm role field is uint8 (1 byte) not uint32.
 */
export function encodeRoleInput({ account, role }) {
  const accountBuf =
    typeof account === "string" ? qubicIdToBytes(account) : Buffer.from(account);
  return Buffer.concat([accountBuf, encodeU8(role)]);
}

/**
 * Encode TransferAdminInput (procedure 10) — 32 bytes.
 * Layout: newAdmin(32)
 */
export function encodeTransferAdminInput({ newAdmin }) {
  return typeof newAdmin === "string"
    ? qubicIdToBytes(newAdmin)
    : Buffer.from(newAdmin);
}

/**
 * Encode EditOracleThresholdInput (procedure 11) — 1 byte.
 * Layout: newThreshold(1)
 * [BLOCKED: S1] Confirm this is uint8, not uint32.
 */
export function encodeEditOracleThresholdInput({ newThreshold }) {
  return encodeU8(newThreshold);
}

/**
 * Encode UnlockInput (procedure 3).
 * Layout: order(128) | numSignatures(4) | signatures[64](each: signer(32)+sig(64)=96)
 * Total: 128 + 4 + 64*96 = 6276 bytes (fixed-size array, unused slots are zeros)
 *
 * [BLOCKED: S1] Confirm exact layout.
 * [BLOCKED: T1.3] K12 hash of the Order must match on-chain computation.
 *
 * @param {{ order: object, signatures: Array<{signer: string, signature: Uint8Array}> }} input
 */
export function encodeUnlockInput({ order, signatures, fixedSigSlots = null }) {
  // fixedSigSlots: if set, pad the signatures array to this many slots (for SC with fixed array).
  // If null, emit only the actual signatures (variable-length, smaller tx).
  const SIG_ENTRY_SIZE = 32 + 64; // signer (32 bytes) + signature (64 bytes)

  const orderBuf = encodeOrder(order);
  const numSigs = encodeU32LE(signatures.length);

  const slotCount = fixedSigSlots != null ? fixedSigSlots : signatures.length;
  const sigsBuf = Buffer.alloc(slotCount * SIG_ENTRY_SIZE, 0);
  for (let i = 0; i < Math.min(signatures.length, slotCount); i++) {
    const { signer, signature } = signatures[i];
    const signerBytes =
      typeof signer === "string" ? qubicIdToBytes(signer) : Buffer.from(signer);
    const sigBytes = Buffer.from(signature);
    if (sigBytes.length !== 64) {
      throw new Error(`Signature ${i} must be 64 bytes`);
    }
    signerBytes.copy(sigsBuf, i * SIG_ENTRY_SIZE);
    sigBytes.copy(sigsBuf, i * SIG_ENTRY_SIZE + 32);
  }

  return Buffer.concat([orderBuf, numSigs, sigsBuf]);
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build and sign a Qubic procedure transaction.
 *
 * @param {object} helper - QubicHelper instance
 * @param {string} seed - caller's seed (55 lowercase letters)
 * @param {number} procedureId - one of PROCEDURE_IDS values
 * @param {Buffer} inputBytes - encoded procedure input
 * @param {number} tick - target tick (fetchCurrentTick() + TICK_OFFSET)
 * @param {bigint} invocationReward - QU attached as reward (0n for most, amount for Lock)
 * @returns {{ signedBytes: Uint8Array, publicId: string, tick: number }}
 */
export async function buildProcedureTx(
  helper,
  seed,
  procedureId,
  inputBytes,
  tick,
  invocationReward = 0n
) {
  const identity = await helper.createIdPackage(seed);

  const payload = new DynamicPayload(inputBytes.length);
  payload.setPayload(new Uint8Array(inputBytes));

  const tx = new QubicTransaction()
    .setSourcePublicKey(identity.publicId)
    .setDestinationPublicKey(CONTRACT_ADDRESS)
    .setTick(tick)
    .setInputType(procedureId)
    .setPayload(payload) // also sets inputSize automatically
    .setAmount(invocationReward); // 0n for most; equals `amount` for Lock

  const signedBytes = await tx.build(seed);
  return { signedBytes, publicId: identity.publicId, tick };
}

/**
 * Sign an arbitrary message with K12 hash + SchnorrQ.
 * Used by oracle relayers to sign the Order struct before submitting Unlock.
 *
 * @param {Buffer|Uint8Array} messageBytes - the bytes to sign (e.g. encoded Order)
 * @param {string} seed - 55-char Qubic seed
 * @returns {{ signer: string, signature: Uint8Array }}
 */
export async function signWithK12(messageBytes, seed) {
  const helper = new _QubicHelper();
  const { K12, schnorrq } = await _cryptoLib;
  const identity = await helper.createIdPackage(seed);
  const digest = new Uint8Array(32);
  K12(new Uint8Array(messageBytes), digest, 32);
  const signature = schnorrq.sign(identity.privateKey, identity.publicKey, digest);
  return { signer: identity.publicId, signature: new Uint8Array(signature) };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

export function logSection(label, title) {
  process.stdout.write(`\n[${label}] ${title}\n`);
}

export function parseArgs(argv, { startIndex = 0 } = {}) {
  const args = { _: [] };
  for (let i = startIndex; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const withoutPrefix = token.slice(2);
    const eqIdx = withoutPrefix.indexOf("=");
    const rawKey =
      eqIdx >= 0 ? withoutPrefix.slice(0, eqIdx) : withoutPrefix;
    const key = rawKey.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (eqIdx >= 0) {
      args[key] = withoutPrefix.slice(eqIdx + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

/**
 * Pad a Solana address (32 bytes) to 64 bytes for use as Qubic toAddress.
 * The Qubic Lock procedure expects a 64-byte destination buffer.
 */
export async function solanaAddressTo64Bytes(base58OrHex) {
  let bytes32;
  if (/^[0-9a-fA-F]{64}$/.test(base58OrHex)) {
    bytes32 = Buffer.from(base58OrHex, "hex");
  } else {
    // base58 decode using a simple approach
    // For production use the @solana/kit getAddressEncoder
    const { getAddressEncoder } = await import("@solana/kit");
    bytes32 = Buffer.from(getAddressEncoder().encode(base58OrHex));
  }
  const buf = Buffer.alloc(64, 0);
  bytes32.copy(buf, 0);
  return buf;
}
