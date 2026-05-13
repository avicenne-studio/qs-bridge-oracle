/**
 * QSB AddRole — grants Oracle (1) or Pauser (2) role to an account.
 * Must be called from the admin identity.
 *
 * Usage:
 *   node scripts/qubic/add-role.js <targetPublicId> <role>
 *
 *   role: 1 = Oracle, 2 = Pauser
 *
 * Env:
 *   QUBIC_BOB_URL  Bob Node  (default: http://localhost:40420)
 *   QUBIC_KEYS     path to admin { sKey, pKey? } JSON
 */

import process from "node:process";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";
import {
  QSB_CONTRACT_INDEX,
  TICK_OFFSET,
  resolveNodeRpcUrl,
  resolveBobUrl,
  resolveQubicKeysPath,
  contractAddressBytes,
  loadQubicKeys,
  createQubicIdPackage,
  getCurrentTick,
  getBalance,
  broadcastViaBob,
  qubicIdToBytes,
} from "./utils.js";

const PROC_ADD_ROLE = 12;
const ROLE_ORACLE = 1;
const ROLE_PAUSER = 2;

const ROLE_NAMES = { [ROLE_ORACLE]: "Oracle", [ROLE_PAUSER]: "Pauser" };

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node add-role.js <targetPublicId> <role>");
  console.error("  role: 1 = Oracle, 2 = Pauser");
  process.exit(1);
}

const targetPublicId = args[0];
const role = parseInt(args[1]);
if (role !== ROLE_ORACLE && role !== ROLE_PAUSER) {
  console.error(`Invalid role: ${role}. Use 1 (Oracle) or 2 (Pauser).`);
  process.exit(1);
}

const keysPath = resolveQubicKeysPath();
if (!keysPath) {
  console.error("QUBIC_KEYS env var must point to the admin keys file.");
  process.exit(1);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

const { sKey: adminSeed } = await loadQubicKeys(keysPath);
const { publicKey: adminPublicKey, publicId: adminPublicId } = await createQubicIdPackage(adminSeed);

console.log(`\n=== QSB AddRole ===`);
console.log(`  Bob Node    : ${bobUrl}`);
console.log(`  Contract    : ${QSB_CONTRACT_INDEX}`);
console.log(`  Admin       : ${adminPublicId}`);
console.log(`  Target      : ${targetPublicId}`);
console.log(`  Role        : ${role} (${ROLE_NAMES[role]})`);

const adminBalance = await getBalance(nodeRpcUrl, adminPublicId);
console.log(`  Admin bal   : ${adminBalance ?? "unknown"} QU`);

// AddRole_input: { id account (32 bytes), uint8 role (1 byte), uint8 padding[7] }
const inputBytes = new Uint8Array(40);
inputBytes.set(qubicIdToBytes(targetPublicId), 0);
inputBytes[32] = role;
// bytes [33..39] = padding zeros (already zero)

const tick = await getCurrentTick(nodeRpcUrl);
if (tick === 0) {
  console.error("\nNode appears to be down (tick = 0)");
  process.exit(1);
}
const targetTick = tick + TICK_OFFSET;
console.log(`  Tick        : ${tick} → target ${targetTick}`);

const dest = new PublicKey(contractAddressBytes(QSB_CONTRACT_INDEX));
const payload = new DynamicPayload(inputBytes.length);
payload.setPayload(inputBytes);

const tx = new QubicTransaction()
  .setSourcePublicKey(new PublicKey(adminPublicKey))
  .setDestinationPublicKey(dest)
  .setAmount(new Long(0))
  .setTick(targetTick)
  .setInputType(PROC_ADD_ROLE)
  .setInputSize(inputBytes.length)
  .setPayload(payload);

const builtTx = await tx.build(adminSeed);
const txId = tx.getId();

console.log(`\n  TX ID       : ${txId}`);

const broadcastResult = await broadcastViaBob(bobUrl, builtTx);
console.log(`  Broadcast   :`, JSON.stringify(broadcastResult));

console.log(`\nWaiting for confirmation...`);
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const currentTick = await getCurrentTick(nodeRpcUrl);
  if (currentTick >= targetTick) {
    console.log(`\nTick ${currentTick} reached. TX: ${bobUrl}/tx/${txId.toLowerCase()}`);
    break;
  }
  process.stdout.write(`\r  Waiting... (tick ${currentTick}/${targetTick})  `);
}

console.log("\nDone.");
