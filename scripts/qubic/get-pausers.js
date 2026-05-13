/**
 * QSB GetPausers — list all pauser accounts registered on the contract.
 *
 * Usage:
 *   node scripts/qubic/get-pausers.js
 *
 * Env:
 *   QUBIC_RPC_URL  Bob Node (default: http://localhost:40420)
 */

import process from "node:process";
import {
  QSB_CONTRACT_INDEX,
  resolveBobUrl,
  queryContractFunction,
  decodeIdArrayOutput,
  bytesToQubicId,
  FUNC_GET_PAUSERS,
} from "./utils.js";

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB GetPausers ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);

const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_PAUSERS, new Uint8Array(0));
const { count, accounts } = decodeIdArrayOutput(buf);

console.log(`\n  count    : ${count}`);

const ids = await Promise.all(accounts.map((b) => bytesToQubicId(b)));
ids.forEach((id, i) => console.log(`  [${i}]      : ${id}`));

console.log("\n" + JSON.stringify({ count, accounts: ids }, null, 2));
