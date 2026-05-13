/**
 * QSB IsOrderFilled — check whether an order hash has already been filled.
 *
 * Usage:
 *   node scripts/qubic/is-order-filled.js <orderHash>
 *
 *   <orderHash>  32-byte order hash as a 64-char hex string (0x prefix optional)
 *
 * Env:
 *   QUBIC_RPC_URL  Bob Node (default: http://localhost:40420)
 */

import process from "node:process";
import { Buffer } from "node:buffer";
import {
  QSB_CONTRACT_INDEX,
  resolveBobUrl,
  queryContractFunction,
  FUNC_IS_ORDER_FILLED,
} from "./utils.js";

const [hashArg] = process.argv.slice(2);
if (!hashArg) {
  console.error("Usage: node is-order-filled.js <orderHash-hex>");
  process.exit(1);
}

const hexStr = hashArg.startsWith("0x") ? hashArg.slice(2) : hashArg;
if (hexStr.length !== 64) {
  console.error("orderHash must be a 64-char hex string (32 bytes)");
  process.exit(1);
}
const hashBytes = Buffer.from(hexStr, "hex");

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB IsOrderFilled ===`);
console.log(`  Bob Node  : ${bobUrl}`);
console.log(`  Contract  : ${QSB_CONTRACT_INDEX}`);
console.log(`  OrderHash : ${hexStr}`);

const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_IS_ORDER_FILLED, hashBytes);
const filled = buf.readUInt8(0) !== 0;

console.log(`\n  filled    : ${filled}`);
console.log("\n" + JSON.stringify({ orderHash: hexStr, filled }, null, 2));
