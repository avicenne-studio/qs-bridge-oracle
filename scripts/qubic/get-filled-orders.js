/**
 * QSB GetFilledOrders — paginated list of filled order hashes.
 *
 * Usage:
 *   node scripts/qubic/get-filled-orders.js [offset] [limit]
 *
 *   offset  skip this many filled entries  (default: 0)
 *   limit   return up to this many entries (default: 10, max: 64)
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
  encodePaginationInput,
  decodeGetFilledOrdersOutput,
  FUNC_GET_FILLED_ORDERS,
} from "./utils.js";

const args = process.argv.slice(2);
const offset = parseInt(args[0] ?? "0", 10);
const limit = parseInt(args[1] ?? "10", 10);

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB GetFilledOrders ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);
console.log(`  Offset   : ${offset}  Limit: ${limit}`);

const buf = await queryContractFunction(
  bobUrl,
  QSB_CONTRACT_INDEX,
  FUNC_GET_FILLED_ORDERS,
  encodePaginationInput(offset, limit),
);
const { totalActive, returned, hashes } = decodeGetFilledOrdersOutput(buf);

console.log(`\n  totalFilled : ${totalActive}`);
console.log(`  returned    : ${returned}`);

const hexHashes = hashes.map((h) => Buffer.from(h).toString("hex"));
hexHashes.forEach((h, i) => console.log(`  [${i}] ${h}`));

console.log(
  "\n" + JSON.stringify({ totalFilled: totalActive, returned, hashes: hexHashes }, null, 2),
);
