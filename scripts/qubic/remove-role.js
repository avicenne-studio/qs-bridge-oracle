/**
 * QSB RemoveRole — revokes oracle or pauser role from an account.
 * Must be called from the admin identity.
 *
 * Usage:
 *   node scripts/qubic/remove-role.js <targetPublicId> --role oracle|pauser
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
  broadcastViaBob,
  qubicIdToBytes,
  queryContractFunction,
  decodeIdArrayOutput,
  bytesToQubicId,
  FUNC_IS_ORACLE,
  FUNC_IS_PAUSER,
  FUNC_GET_ORACLES,
  FUNC_GET_PAUSERS,
} from "./utils.js";

const PROC_REMOVE_ROLE = 13;
const ROLE_ORACLE = 1;
const ROLE_PAUSER = 2;

// ── arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const roleFlag = args.indexOf("--role");
if (args.length < 1 || roleFlag === -1 || !args[roleFlag + 1]) {
  console.error("Usage: node remove-role.js <targetPublicId> --role oracle|pauser");
  process.exit(1);
}

const targetPublicId = args[0];
const roleName = args[roleFlag + 1].toLowerCase();
if (roleName !== "oracle" && roleName !== "pauser") {
  console.error(`Invalid --role: "${roleName}". Use oracle or pauser.`);
  process.exit(1);
}
const role = roleName === "oracle" ? ROLE_ORACLE : ROLE_PAUSER;
const isFunc = role === ROLE_ORACLE ? FUNC_IS_ORACLE : FUNC_IS_PAUSER;
const listFunc = role === ROLE_ORACLE ? FUNC_GET_ORACLES : FUNC_GET_PAUSERS;
const listName = role === ROLE_ORACLE ? "oracles" : "pausers";

const keysPath = resolveQubicKeysPath();
if (!keysPath) {
  console.error("QUBIC_KEYS env var must point to the admin keys file.");
  process.exit(1);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { sKey: adminSeed } = await loadQubicKeys(keysPath);
const { publicKey: adminPublicKey, publicId: adminPublicId } = await createQubicIdPackage(adminSeed);

console.log(`\n=== QSB RemoveRole ===`);
console.log(`  Admin  : ${adminPublicId}`);
console.log(`  Target : ${targetPublicId}`);
console.log(`  Role   : ${roleName}`);

// ── pre-check: actually registered? ──────────────────────────────────────────

const targetBytes = qubicIdToBytes(targetPublicId);
const isBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, isFunc, targetBytes);
const isRegistered = isBuf.readUInt8(0) !== 0;

if (!isRegistered) {
  console.log(`\n  Not registered as ${roleName} — no transaction sent.`);
  await printMembership(bobUrl, listFunc, listName);
  process.exit(0);
}

// ── send RemoveRole tx ────────────────────────────────────────────────────────

// RemoveRole_input: id account (32 bytes) + uint8 role (1 byte) + padding[7]
const inputBytes = new Uint8Array(40);
inputBytes.set(targetBytes, 0);
inputBytes[32] = role;

const tick = await getCurrentTick(nodeRpcUrl);
if (tick === 0) { console.error("Node down (tick=0)"); process.exit(1); }
const targetTick = tick + TICK_OFFSET;

const dest = new PublicKey(contractAddressBytes(QSB_CONTRACT_INDEX));
const payload = new DynamicPayload(inputBytes.length);
payload.setPayload(inputBytes);

const tx = new QubicTransaction()
  .setSourcePublicKey(new PublicKey(adminPublicKey))
  .setDestinationPublicKey(dest)
  .setAmount(new Long(0))
  .setTick(targetTick)
  .setInputType(PROC_REMOVE_ROLE)
  .setInputSize(inputBytes.length)
  .setPayload(payload);

const builtTx = await tx.build(adminSeed);
const txId = tx.getId();
console.log(`\n  TX ID  : ${txId}`);
console.log(`  Tick   : ${tick} → ${targetTick}`);

await broadcastViaBob(bobUrl, builtTx);

// ── wait for confirmation ─────────────────────────────────────────────────────

process.stdout.write("  Waiting...");
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if ((await getCurrentTick(nodeRpcUrl)) >= targetTick) break;
  process.stdout.write(".");
}
process.stdout.write("\n");

// ── verify (poll until state is consistent) ───────────────────────────────────

process.stdout.write("  Verifying");
let stillRegistered = true;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const verifyBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, isFunc, targetBytes);
  stillRegistered = verifyBuf.readUInt8(0) !== 0;
  if (!stillRegistered) break;
  process.stdout.write(".");
}
process.stdout.write("\n");
console.log(`  is-${roleName}(target) : ${stillRegistered} ${!stillRegistered ? "✓" : "✗ (tx may have failed)"}`);

await printMembership(bobUrl, listFunc, listName);

// ── helpers ───────────────────────────────────────────────────────────────────

async function printMembership(url, func, label) {
  const buf = await queryContractFunction(url, QSB_CONTRACT_INDEX, func, null);
  const { count, accounts } = decodeIdArrayOutput(buf);
  console.log(`\n  ${label} (${count}):`);
  for (const acc of accounts) {
    console.log(`    ${await bytesToQubicId(acc)}`);
  }
}
