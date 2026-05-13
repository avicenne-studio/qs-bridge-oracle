/**
 * QSB IsPauser — check whether an identity holds the Pauser role.
 *
 * Usage:
 *   node scripts/qubic/is-pauser.js <identity>
 *
 *   <identity>  60-char Qubic public ID
 *
 * Env:
 *   QUBIC_RPC_URL  Bob Node (default: http://localhost:40420)
 */

import process from "node:process";
import {
  QSB_CONTRACT_INDEX,
  resolveBobUrl,
  queryContractFunction,
  qubicIdToBytes,
  FUNC_IS_PAUSER,
} from "./utils.js";

const [identity] = process.argv.slice(2);
if (!identity) {
  console.error("Usage: node is-pauser.js <identity>");
  process.exit(1);
}

const bobUrl = resolveBobUrl();
const accountBytes = qubicIdToBytes(identity);

console.log(`\n=== QSB IsPauser ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);
console.log(`  Identity : ${identity}`);

const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_IS_PAUSER, accountBytes);
const isPauser = buf.readUInt8(0) !== 0;

console.log(`\n  isPauser : ${isPauser}`);
console.log("\n" + JSON.stringify({ identity, isPauser }, null, 2));
