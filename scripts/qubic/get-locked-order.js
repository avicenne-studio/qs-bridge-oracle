/**
 * QSB GetLockedOrder — look up a single locked order by nonce.
 *
 * Usage:
 *   node scripts/qubic/get-locked-order.js <nonce>
 *
 *   <nonce>  uint32 nonce used in the original Lock transaction
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
  encodeGetLockedOrderInput,
  decodeGetLockedOrderOutput,
  bytesToQubicId,
  FUNC_GET_LOCKED_ORDER,
} from "./utils.js";

const [nonceArg] = process.argv.slice(2);
if (nonceArg === undefined) {
  console.error("Usage: node get-locked-order.js <nonce>");
  process.exit(1);
}
const nonce = parseInt(nonceArg, 10);

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB GetLockedOrder ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);
console.log(`  Nonce    : ${nonce}`);

const buf = await queryContractFunction(
  bobUrl,
  QSB_CONTRACT_INDEX,
  FUNC_GET_LOCKED_ORDER,
  encodeGetLockedOrderInput(nonce),
);
const { exists, order } = decodeGetLockedOrderOutput(buf);

console.log(`\n  exists   : ${exists}`);
if (exists) {
  const senderId = await bytesToQubicId(order.sender);
  const toAddrStr = Buffer.from(order.toAddress).toString("utf8").replace(/\0/g, "");
  const hashHex = Buffer.from(order.orderHash).toString("hex");

  console.log(`  sender      : ${senderId}`);
  console.log(`  amount      : ${order.amount}`);
  console.log(`  relayerFee  : ${order.relayerFee}`);
  console.log(`  networkOut  : ${order.networkOut}`);
  console.log(`  nonce       : ${order.nonce}`);
  console.log(`  toAddress   : ${toAddrStr}`);
  console.log(`  orderHash   : ${hashHex}`);
  console.log(`  lockEpoch   : ${order.lockEpoch}`);
  console.log(`  orderEra    : ${order.orderEra}`);
  console.log(`  active      : ${order.active}`);

  console.log(
    "\n" +
      JSON.stringify(
        {
          exists,
          order: {
            sender: senderId,
            amount: order.amount.toString(),
            relayerFee: order.relayerFee.toString(),
            networkOut: order.networkOut,
            nonce: order.nonce,
            toAddress: toAddrStr,
            orderHash: hashHex,
            lockEpoch: order.lockEpoch,
            orderEra: order.orderEra,
            active: order.active,
          },
        },
        null,
        2,
      ),
  );
} else {
  console.log("\n" + JSON.stringify({ exists }, null, 2));
}
