import { Buffer } from "node:buffer";
import { type ReadonlyUint8Array } from "@solana/kit";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;
const HEX_PATTERN = /^[0-9a-fA-F]*$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function bytesToHex(value: ReadonlyUint8Array): string {
  return Buffer.from(value).toString("hex");
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
