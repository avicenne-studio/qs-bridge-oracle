/**
 * QSB IsOracle — check whether an identity holds the Oracle role.
 *
 * Usage:
 *   node scripts/qubic/is-oracle.js <identity>
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
  FUNC_IS_ORACLE,
} from "./utils.js";

const [identity] = process.argv.slice(2);
if (!identity) {
  console.error("Usage: node is-oracle.js <identity>");
  process.exit(1);
}

const bobUrl = resolveBobUrl();
const accountBytes = qubicIdToBytes(identity);

console.log(`\n=== QSB IsOracle ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);
console.log(`  Identity : ${identity}`);

const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_IS_ORACLE, accountBytes);
const isOracle = buf.readUInt8(0) !== 0;

console.log(`\n  isOracle : ${isOracle}`);
console.log("\n" + JSON.stringify({ identity, isOracle }, null, 2));
