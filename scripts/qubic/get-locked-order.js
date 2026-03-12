/**
 * get-locked-order.js
 * Query an active locked order by nonce via GetLockedOrder (function 4).
 *
 * Usage:
 *   node scripts/qubic/get-locked-order.js --nonce <uint32>
 *
 * [BLOCKED: S6] Requires querySmartContract on testnet RPC.
 * [BLOCKED: S1] Response decoding layout must be confirmed by Seeker.
 */

import { Buffer } from "node:buffer";
import process from "node:process";
import {
  querySmartContract,
  FUNCTION_IDS,
  QUBIC_RPC_URL,
  logSection,
  parseArgs,
} from "./utils.js";

function encodeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

/**
 * Decode GetLockedOrder output.
 * Confirmed layout (168 bytes total):
 *   exists(8/u64) | sender(32) | amount(8) | relayerFee(8) |
 *   networkOut(4) | nonce(4) | toAddress(64) | orderHash(32) |
 *   lockEpoch(4) | active(4/u32)
 */
function decodeGetLockedOrderOutput(buf) {
  if (buf.length < 8) return { raw: buf.toString("hex") };
  let offset = 0;
  const exists = buf.readBigUInt64LE(offset) !== 0n; offset += 8;
  if (!exists) return { exists };
  const sender = buf.slice(offset, offset + 32).toString("hex"); offset += 32;
  const amount = buf.readBigUInt64LE(offset).toString(); offset += 8;
  const relayerFee = buf.readBigUInt64LE(offset).toString(); offset += 8;
  const networkOut = buf.readUInt32LE(offset); offset += 4;
  const nonce = buf.readUInt32LE(offset); offset += 4;
  const toAddress = buf.slice(offset, offset + 64).toString("hex"); offset += 64;
  const orderHash = buf.slice(offset, offset + 32).toString("hex"); offset += 32;
  const lockEpoch = buf.readUInt32LE(offset); offset += 4;
  const active = buf.readUInt32LE(offset) !== 0;

  return { exists, sender, amount, relayerFee, networkOut, nonce, toAddress, orderHash, lockEpoch, active };
}

async function main() {
  const args = parseArgs(process.argv, { startIndex: 2 });
  const nonce = args.nonce != null ? Number(args.nonce) : null;

  if (nonce == null) {
    throw new Error("Usage: node scripts/qubic/get-locked-order.js --nonce <uint32>");
  }

  logSection("get-locked-order", `nonce=${nonce} @ ${QUBIC_RPC_URL}`);

  const inputBytes = encodeU32LE(nonce);
  const response = await querySmartContract(FUNCTION_IDS.GetLockedOrder, inputBytes);

  logSection("get-locked-order", "Raw response");
  process.stdout.write(JSON.stringify(response, null, 2) + "\n");

  if (response.responseData) {
    const buf = Buffer.from(response.responseData, "base64");
    logSection("get-locked-order", "Decoded");
    const decoded = decodeGetLockedOrderOutput(buf);
    process.stdout.write(JSON.stringify(decoded, null, 2) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
