/**
 * QSB GetLockedOrders — paginated list of active locked orders.
 *
 * Usage:
 *   node scripts/qubic/get-locked-orders.js [offset] [limit]
 *
 *   offset  skip this many active entries  (default: 0)
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
  decodeGetLockedOrdersOutput,
  bytesToQubicId,
  FUNC_GET_LOCKED_ORDERS,
} from "./utils.js";

const args = process.argv.slice(2);
const offset = parseInt(args[0] ?? "0", 10);
const limit = parseInt(args[1] ?? "10", 10);

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB GetLockedOrders ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);
console.log(`  Offset   : ${offset}  Limit: ${limit}`);

const buf = await queryContractFunction(
  bobUrl,
  QSB_CONTRACT_INDEX,
  FUNC_GET_LOCKED_ORDERS,
  encodePaginationInput(offset, limit),
);
const { totalActive, returned, entries } = decodeGetLockedOrdersOutput(buf);

console.log(`\n  totalActive : ${totalActive}`);
console.log(`  returned    : ${returned}`);

const jsonEntries = await Promise.all(
  entries.map(async (e) => {
    const senderId = await bytesToQubicId(e.sender);
    const toAddrStr = Buffer.from(e.toAddress).toString("utf8").replace(/\0/g, "");
    const hashHex = Buffer.from(e.orderHash).toString("hex");
    console.log(`\n  --- Order nonce=${e.nonce} ---`);
    console.log(`    sender     : ${senderId}`);
    console.log(`    amount     : ${e.amount}`);
    console.log(`    relayerFee : ${e.relayerFee}`);
    console.log(`    networkOut : ${e.networkOut}`);
    console.log(`    toAddress  : ${toAddrStr}`);
    console.log(`    orderHash  : ${hashHex}`);
    console.log(`    lockEpoch  : ${e.lockEpoch}`);
    console.log(`    orderEra   : ${e.orderEra}`);
    return {
      sender: senderId,
      amount: e.amount.toString(),
      relayerFee: e.relayerFee.toString(),
      networkOut: e.networkOut,
      nonce: e.nonce,
      toAddress: toAddrStr,
      orderHash: hashHex,
      lockEpoch: e.lockEpoch,
      orderEra: e.orderEra,
      active: e.active,
    };
  }),
);

console.log("\n" + JSON.stringify({ totalActive, returned, entries: jsonEntries }, null, 2));
