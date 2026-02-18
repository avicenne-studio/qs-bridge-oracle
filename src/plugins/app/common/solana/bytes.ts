import { Buffer } from "node:buffer";
import { type ReadonlyUint8Array } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;
const HEX_PATTERN = /^[0-9a-fA-F]*$/;
const DECIMAL_PATTERN = /^[0-9]+$/;
const ADDRESS_HEX_LENGTH = 64;
const NONCE_BYTE_LENGTH = 32;
const QUBIC_ID_ALPHABET = /^[A-Za-z]+$/;
const CHAR_A = "A".charCodeAt(0);

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function leftPadToLength(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length > length) {
    throw new Error(`value must be at most ${length} bytes`);
  }
  if (bytes.length === length) {
    return bytes;
  }
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

function qubicIdToBytes(s: string): Uint8Array {
  const str = s.toUpperCase();
  const len = str.length;
  const segmentLength =
    len === 60 ? 15 : len === 56 ? 14 : len === 52 ? 13 : 12;
  const publicKeyBytes = new Uint8Array(32);
  const view = new DataView(publicKeyBytes.buffer, 0);
  for (let i = 0; i < 4; i++) {
    view.setBigUint64(i * 8, 0n, true);
    for (let j = segmentLength - 1; j >= 0; j--) {
      const idx = i * segmentLength + j;
      const code = str.charCodeAt(idx) - CHAR_A;
      view.setBigUint64(
        i * 8,
        view.getBigUint64(i * 8, true) * 26n + BigInt(code),
        true,
      );
    }
  }
  return publicKeyBytes;
}

/** Hex (64), Qubic ID (48-60), or Solana base58 -> 32 bytes. */
export function addressOrIdToBytes(value: string): Uint8Array {
  const s = value.trim();
  const hexCandidate = normalizeHex(s.replace(/\s/g, ""));
  if (hexCandidate.length === ADDRESS_HEX_LENGTH && HEX_PATTERN.test(hexCandidate)) {
    return hexToBytes(s.replace(/\s/g, ""));
  }
  if (s.length >= 48 && s.length <= 60 && s.length % 4 === 0 && QUBIC_ID_ALPHABET.test(s)) {
    return qubicIdToBytes(s);
  }
  return new Uint8Array(new PublicKey(s).toBytes());
}

/** Hex nonce (with optional 0x prefix) -> 32 bytes left-padded. */
export function nonceToBytes(value: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (normalized.length === 0 || !HEX_PATTERN.test(normalized)) {
    throw new Error("nonce must be a hex string");
  }
  if (normalized.length % 2 !== 0) {
    throw new Error("hex nonce must be byte aligned");
  }
  return leftPadToLength(
    new Uint8Array(Buffer.from(normalized, "hex")),
    NONCE_BYTE_LENGTH,
  );
}

export function bytesToHex(value: ReadonlyUint8Array): string {
  return Buffer.from(value).toString("hex");
}

/** 32-byte nonce (big-endian) -> decimal string. For order lookup when Solana sends nonce as bytes. */
export function nonceBytesToDecimal(nonce: ReadonlyUint8Array): string {
  if (nonce.length !== NONCE_BYTE_LENGTH) {
    throw new Error(`nonce must be ${NONCE_BYTE_LENGTH} bytes`);
  }
  let n = 0n;
  for (let i = 0; i < NONCE_BYTE_LENGTH; i++) {
    n = (n << 8n) | BigInt(nonce[i]!);
  }
  return n.toString();
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (normalized.length % 2 !== 0) {
    throw new Error("hex value must be byte aligned");
  }
  if (!HEX_PATTERN.test(normalized)) {
    throw new Error("hex value contains non-hex characters");
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

export function hex32(value: number): string {
  return Buffer.from(new Uint8Array(32).fill(value)).toString("hex");
}

export function toSafeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new Error(`${field} exceeds max safe integer`);
  }
  return Number(value);
}

export function toSafeBigInt(value: number, field: string): bigint {
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${field} exceeds max safe integer`);
  }
  return BigInt(value);
}

export function toU64BigInt(value: string, field: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`${field} must be an integer string`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_U64) {
    throw new Error(`${field} exceeds uint64`);
  }
  return parsed;
}

export function decodeSecretKey(encoded: string): Uint8Array {
  const trimmed = encoded.trim();
  const bytes = new Uint8Array(Buffer.from(trimmed, "base64"));
  if (bytes.length !== 64) {
    throw new Error("secret key must be 64 bytes");
  }
  return bytes;
}

export function normalizeSignatureValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  throw new Error("unsupported signature format");
}

export function parseU32(value: number | string, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`${field} must be uint32`);
  }
  return parsed;
}

export function parseU64(value: bigint | number | string, field: string): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : BigInt(typeof value === "string" ? value : Math.trunc(value));
  if (parsed < 0n || parsed > MAX_U64) {
    throw new Error(`${field} must be uint64`);
  }
  return parsed;
}

export function assertFixedBytes(value: Uint8Array, field: string, length: number) {
  if (value.length !== length) {
    throw new Error(`${field} must be ${length} bytes`);
  }
}
