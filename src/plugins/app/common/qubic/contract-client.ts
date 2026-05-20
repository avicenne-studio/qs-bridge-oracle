import { Buffer } from "node:buffer";
import { QSB_CONTRACT_INDEX } from "./encoding.js";

export const FUNC_GET_CONFIG = 1;
export const FUNC_GET_LOCKED_ORDER = 4;
export const FUNC_GET_ORACLES = 7;
export const FUNC_GET_LOCKED_ORDERS = 9;
export const FUNC_GET_FILLED_ORDERS = 10;

const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 300;
const LOCKED_ORDER_ENTRY_SIZE = 168;

export type LockedOrder = {
  sender: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  networkOut: number;
  nonce: number;
  toAddress: Uint8Array;
  orderHash: Uint8Array;
  lockEpoch: number;
  orderEra: number;
  active: boolean;
};

/** Encode GetLockedOrder_input: uint32 nonce LE, returned as hex. */
export function encodeGetLockedOrderInput(nonce: number): string {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(nonce >>> 0, 0);
  return buf.toString("hex");
}

/**
 * Query a QSB contract view function via Bob Node POST /querySmartContract.
 * Retries up to MAX_RETRIES times on pending responses (300 ms between attempts).
 * Returns the raw output as a hex string.
 *
 * Bob Node request body: { nonce, scIndex, funcNumber, data (hex) }
 * Bob Node response: { data: string (hex) } | { error: "pending" }
 */
export async function queryContractFunction(
  bobUrl: string,
  funcNumber: number,
  inputHex: string,
): Promise<string> {
  const nonce = (Math.random() * 0xffffffff) >>> 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
    const res = await fetch(`${bobUrl}/querySmartContract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, scIndex: QSB_CONTRACT_INDEX, funcNumber, data: inputHex }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`querySmartContract HTTP ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { error?: string; data?: unknown };
    if (body.error === "pending") continue;
    if (typeof body.data !== "string") {
      throw new Error(`querySmartContract: unexpected response: ${JSON.stringify(body)}`);
    }
    return body.data;
  }
  throw new Error(`querySmartContract func=${funcNumber}: still pending after ${MAX_RETRIES} retries`);
}

/**
 * Decode a LockedOrderEntry (168 bytes) at `offset` within `buf`.
 *
 * Layout (packed, natural C++ alignment, LE):
 *   [+0..+31]   id        sender
 *   [+32..+39]  u64       amount
 *   [+40..+47]  u64       relayerFee
 *   [+48..+51]  u32       networkOut
 *   [+52..+55]  u32       nonce
 *   [+56..+119] u8[64]    toAddress (ASCII Solana address, zero-padded)
 *   [+120..+151] u8[32]   orderHash (K12 digest)
 *   [+152..+155] u32      lockEpoch
 *   [+156..+159] u32      orderEra
 *   [+160]      bit       active (1 byte)
 *   [+161..+167] --       7 bytes padding
 */
function decodeLockedOrderEntry(buf: Buffer, offset: number): LockedOrder {
  return {
    sender: new Uint8Array(buf.subarray(offset, offset + 32)),
    amount: buf.readBigUInt64LE(offset + 32),
    relayerFee: buf.readBigUInt64LE(offset + 40),
    networkOut: buf.readUInt32LE(offset + 48),
    nonce: buf.readUInt32LE(offset + 52),
    toAddress: new Uint8Array(buf.subarray(offset + 56, offset + 120)),
    orderHash: new Uint8Array(buf.subarray(offset + 120, offset + 152)),
    lockEpoch: buf.readUInt32LE(offset + 152),
    orderEra: buf.readUInt32LE(offset + 156),
    active: buf.readUInt8(offset + 160) !== 0,
  };
}

/**
 * Decode GetLockedOrder_output (176 bytes).
 *
 * Layout: bit exists (1) + 7 bytes padding + LockedOrderEntry (168)
 * Returns null when exists === false.
 */
export function decodeGetLockedOrder(hex: string): LockedOrder | null {
  const buf = Buffer.from(hex, "hex");
  if (buf.readUInt8(0) === 0) return null;
  return decodeLockedOrderEntry(buf, 8);
}

/**
 * Decode GetOracles_output.
 *
 * Layout: u32 count + 4 bytes padding + Array<id, 64> (id = 32 bytes, 8-byte aligned)
 * Returns the raw 32-byte public keys.
 */
export function decodeGetOracles(hex: string): Uint8Array[] {
  const buf = Buffer.from(hex, "hex");
  const count = buf.readUInt32LE(0);
  const keys: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(new Uint8Array(buf.subarray(8 + i * 32, 8 + (i + 1) * 32)));
  }
  return keys;
}

/**
 * Decode GetLockedOrders_output.
 *
 * Layout: u32 totalActive + u32 returned + Array<LockedOrderEntry(168), 64>
 */
export function decodeGetLockedOrders(hex: string): {
  totalActive: number;
  returned: number;
  entries: LockedOrder[];
} {
  const buf = Buffer.from(hex, "hex");
  const totalActive = buf.readUInt32LE(0);
  const returned = buf.readUInt32LE(4);
  const entries: LockedOrder[] = [];
  for (let i = 0; i < returned; i++) {
    entries.push(decodeLockedOrderEntry(buf, 8 + i * LOCKED_ORDER_ENTRY_SIZE));
  }
  return { totalActive, returned, entries };
}
