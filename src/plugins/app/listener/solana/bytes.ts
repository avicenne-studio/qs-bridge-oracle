import { Buffer } from "node:buffer";
import { type ReadonlyUint8Array } from "@solana/kit";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const HEX_PATTERN = /^[0-9a-fA-F]*$/;

function normalizeHex(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function bytesToHex(value: ReadonlyUint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function hexToBytes(value: string): Uint8Array {
  const normalized = normalizeHex(value);
  if (normalized.length % 2 !== 0) {
    throw new Error("SolanaListener: hex value must be byte aligned");
  }
  if (!HEX_PATTERN.test(normalized)) {
    throw new Error("SolanaListener: hex value contains non-hex characters");
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

export function toSafeNumber(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new Error(`SolanaListener: ${field} exceeds max safe integer`);
  }
  return Number(value);
}

export function toSafeBigInt(value: number, field: string): bigint {
  if (!Number.isInteger(value)) {
    throw new Error(`SolanaListener: ${field} must be an integer`);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`SolanaListener: ${field} exceeds max safe integer`);
  }
  return BigInt(value);
}

export function nonceToOrderId(nonce: ReadonlyUint8Array): number {
  if (nonce.length !== 32) {
    throw new Error("SolanaListener: nonce must be 32 bytes");
  }
  const hex = bytesToHex(nonce);
  const numeric = BigInt(`0x${hex}`);
  if (numeric < 1n || numeric > MAX_SAFE_BIGINT) {
    throw new Error("SolanaListener: nonce does not fit into order id");
  }
  return Number(numeric);
}

export const autoload = false