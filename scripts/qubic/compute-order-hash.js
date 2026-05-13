/**
 * QSB ComputeOrderHash — ask the contract to compute the canonical K12 hash
 * for a given Order struct.
 *
 * Usage:
 *   node scripts/qubic/compute-order-hash.js '<json>'
 *   node scripts/qubic/compute-order-hash.js order.json
 *
 * The JSON object supports these fields (all optional except amount):
 *   fromAddress  Qubic ID or 64-char hex  (default: all-zero id)
 *   toAddress    Qubic ID or 64-char hex  (default: all-zero id / NULL_ID)
 *   tokenIn      32-byte hex              (default: zeros)
 *   tokenOut     32-byte hex              (default: zeros)
 *   amount       uint64 (string or number)
 *   relayerFee   uint64 (string or number, default: 0)
 *   networkIn    uint32                   (default: 1 — Qubic)
 *   networkOut   uint32                   (default: 2 — Solana)
 *   nonce        uint32  → auto-encoded as 4 LE bytes in 32-byte array
 *   orderEra     uint32                   (default: 0)
 *
 * Env:
 *   QUBIC_RPC_URL  Bob Node (default: http://localhost:40420)
 */

import process from "node:process";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import {
  QSB_CONTRACT_INDEX,
  resolveBobUrl,
  queryContractFunction,
  encodeOrderStruct,
  qubicIdToBytes,
  FUNC_COMPUTE_ORDER_HASH,
} from "./utils.js";

// ── Parse input ────────────────────────────────────────────────────────────

const [arg] = process.argv.slice(2);
if (!arg) {
  console.error(
    "Usage: node compute-order-hash.js '<json>' | <file.json>\n" +
      "  Required field: amount\n" +
      "  Optional: fromAddress toAddress tokenIn tokenOut relayerFee networkIn networkOut nonce orderEra",
  );
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(arg);
} catch {
  // treat as file path
  const content = await readFile(arg, "utf-8");
  raw = JSON.parse(content);
}

function hexOrIdToBytes(value) {
  if (!value) return new Uint8Array(32);
  const s = String(value).trim();
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return new Uint8Array(Buffer.from(hex, "hex"));
  return qubicIdToBytes(s);
}

function hexToBytes32(value) {
  if (!value) return new Uint8Array(32);
  const hex = String(value).startsWith("0x") ? String(value).slice(2) : String(value);
  const b = Buffer.from(hex, "hex");
  const out = new Uint8Array(32);
  out.set(b.slice(0, 32));
  return out;
}

function nonceToBytes32(nonce) {
  const n = nonce >>> 0;
  const out = new Uint8Array(32);
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  return out;
}

const order = {
  fromAddress: hexOrIdToBytes(raw.fromAddress),
  toAddress: hexOrIdToBytes(raw.toAddress),
  tokenIn: hexToBytes32(raw.tokenIn),
  tokenOut: hexToBytes32(raw.tokenOut),
  amount: BigInt(raw.amount ?? 0),
  relayerFee: BigInt(raw.relayerFee ?? 0),
  networkIn: raw.networkIn ?? 1,
  networkOut: raw.networkOut ?? 2,
  nonce: nonceToBytes32(raw.nonce ?? 0),
  orderEra: raw.orderEra ?? 0,
};

const inputBytes = encodeOrderStruct(order);

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB ComputeOrderHash ===`);
console.log(`  Bob Node   : ${bobUrl}`);
console.log(`  Contract   : ${QSB_CONTRACT_INDEX}`);
console.log(`  amount     : ${order.amount}`);
console.log(`  relayerFee : ${order.relayerFee}`);
console.log(`  networkIn  : ${order.networkIn}  networkOut: ${order.networkOut}`);
console.log(`  orderEra   : ${order.orderEra}`);

const buf = await queryContractFunction(
  bobUrl,
  QSB_CONTRACT_INDEX,
  FUNC_COMPUTE_ORDER_HASH,
  inputBytes,
);
const hashHex = buf.slice(0, 32).toString("hex");

console.log(`\n  orderHash  : ${hashHex}`);
console.log("\n" + JSON.stringify({ orderHash: hashHex }, null, 2));
