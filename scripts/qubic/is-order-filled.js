/**
 * is-order-filled.js
 * Check if an order hash is in the filled/cancelled set via IsOrderFilled (function 5).
 * Used to verify replay protection after unlock, cancel, or epoch expiry.
 *
 * Usage:
 *   node scripts/qubic/is-order-filled.js --hash <32-byte-hex>
 *
 * [BLOCKED: S6] Requires querySmartContract on testnet RPC.
 * [BLOCKED: S1] Response decoding must be confirmed.
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

async function main() {
  const args = parseArgs(process.argv, { startIndex: 2 });
  const hashHex = args.hash;

  if (!hashHex) {
    throw new Error(
      "Usage: node scripts/qubic/is-order-filled.js --hash <32-byte-hex>"
    );
  }

  const normalized = hashHex.startsWith("0x") ? hashHex.slice(2) : hashHex;
  if (normalized.length !== 64) {
    throw new Error("--hash must be a 64-char hex string (32 bytes)");
  }
  const inputBytes = Buffer.from(normalized, "hex");

  logSection("is-order-filled", `hash=${normalized} @ ${QUBIC_RPC_URL}`);

  const response = await querySmartContract(FUNCTION_IDS.IsOrderFilled, inputBytes);

  logSection("is-order-filled", "Raw response");
  process.stdout.write(JSON.stringify(response, null, 2) + "\n");

  if (response.responseData) {
    const buf = Buffer.from(response.responseData, "base64");
    // [BLOCKED: S1] Response layout: filled(1 byte)
    const filled = buf.length > 0 ? buf.readUInt8(0) !== 0 : null;
    logSection("is-order-filled", "Decoded");
    process.stdout.write(JSON.stringify({ filled }, null, 2) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
