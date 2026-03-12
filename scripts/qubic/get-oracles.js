/**
 * get-oracles.js
 * List all registered oracles via GetOracles (function id 7).
 *
 * Usage:
 *   node scripts/qubic/get-oracles.js
 *
 * [BLOCKED: S6] Requires querySmartContract on the testnet RPC.
 * [BLOCKED: S1] Response decoding assumes: count(4) + accounts[64](32B each).
 */

import { Buffer } from "node:buffer";
import process from "node:process";
import {
  querySmartContract,
  FUNCTION_IDS,
  QUBIC_RPC_URL,
  logSection,
} from "./utils.js";

/**
 * Decode GetOracles output.
 * Layout: count(4) | accounts[64 * 32 bytes]
 */
function decodeGetOraclesOutput(buf) {
  if (buf.length < 8) {
    return { raw: buf.toString("hex"), note: "Buffer too short" };
  }
  // count is uint64 LE (8 bytes)
  const count = Number(buf.readBigUInt64LE(0));
  const accounts = [];
  for (let i = 0; i < count && i < 64; i++) {
    const offset = 8 + i * 32;
    if (offset + 32 > buf.length) break;
    accounts.push(buf.slice(offset, offset + 32).toString("hex"));
  }
  return { count, accounts };
}

async function main() {
  logSection("get-oracles", `Contract index 24 @ ${QUBIC_RPC_URL}`);

  const response = await querySmartContract(FUNCTION_IDS.GetOracles);

  logSection("get-oracles", "Raw response");
  process.stdout.write(JSON.stringify(response, null, 2) + "\n");

  if (response.responseData) {
    const buf = Buffer.from(response.responseData, "base64");
    logSection("get-oracles", "Decoded");
    const decoded = decodeGetOraclesOutput(buf);
    process.stdout.write(JSON.stringify(decoded, null, 2) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
