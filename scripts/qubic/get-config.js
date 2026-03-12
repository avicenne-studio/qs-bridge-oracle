/**
 * get-config.js
 * Read the contract config via GetConfig (function id 1).
 * Shows: admin, oracle count, threshold, paused status, fee params.
 *
 * Usage:
 *   node scripts/qubic/get-config.js
 *
 * [BLOCKED: S6] Requires querySmartContract to be available on the testnet RPC.
 * [BLOCKED: S1] Response decoding below assumes byte layout from implementation-plan.md.
 *               Seeker must confirm field sizes and ordering.
 */

import { Buffer } from "node:buffer";
import process from "node:process";
import {
  querySmartContract,
  FUNCTION_IDS,
  QUBIC_RPC_URL,
  logSection,
} from "./utils.js";

/** Decode a 32-byte buffer to Qubic ID hex string (for display). */
function bytesToHex(buf) {
  return buf.toString("hex");
}

/**
 * Decode GetConfig output.
 * [BLOCKED: S1] Field sizes are approximate — confirm with Seeker.
 * Assumed layout:
 *   admin(32) | protocolFeeRecipient(32) | oracleFeeRecipient(32) |
 *   bpsFee(4) | protocolFee(4) | oracleCount(1) | pauserCount(1) |
 *   oracleThreshold(1) | paused(1)
 * Total: ~108 bytes
 */
function decodeGetConfigOutput(buf) {
  if (buf.length < 100) {
    return { raw: buf.toString("hex"), note: "Buffer too short — check S1 layout" };
  }
  let offset = 0;
  const admin = bytesToHex(buf.slice(offset, offset + 32)); offset += 32;
  const protocolFeeRecipient = bytesToHex(buf.slice(offset, offset + 32)); offset += 32;
  const oracleFeeRecipient = bytesToHex(buf.slice(offset, offset + 32)); offset += 32;
  const bpsFee = buf.readUInt32LE(offset); offset += 4;
  const protocolFee = buf.readUInt32LE(offset); offset += 4;
  // [BLOCKED: S1] These might be uint8 or uint32 — using uint8 for now
  const oracleCount = buf.readUInt8(offset); offset += 1;
  const pauserCount = buf.readUInt8(offset); offset += 1;
  const oracleThreshold = buf.readUInt8(offset); offset += 1;
  const paused = buf.readUInt8(offset) !== 0; offset += 1;

  return {
    admin,
    protocolFeeRecipient,
    oracleFeeRecipient,
    bpsFee,
    protocolFee,
    oracleCount,
    pauserCount,
    oracleThreshold,
    paused,
  };
}

async function main() {
  logSection("get-config", `Contract index ${24} @ ${QUBIC_RPC_URL}`);

  const response = await querySmartContract(FUNCTION_IDS.GetConfig);

  logSection("get-config", "Raw response");
  process.stdout.write(JSON.stringify(response, null, 2) + "\n");

  if (response.responseData) {
    const buf = Buffer.from(response.responseData, "base64");
    logSection("get-config", "Decoded");
    const decoded = decodeGetConfigOutput(buf);
    process.stdout.write(JSON.stringify(decoded, null, 2) + "\n");
  } else {
    process.stdout.write("No responseData in response.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
