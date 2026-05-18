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
import {
  QSB_CONTRACT_INDEX,
  resolveNodeRpcUrl,
  resolveBobUrl,
  requireQubicKeys,
  buildAndBroadcastTx,
  waitForTick,
  pollUntil,
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

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { seed: adminSeed, publicKey: adminPublicKey, publicId: adminPublicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the admin keys file.");

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

const { targetTick } = await buildAndBroadcastTx({
  publicKey: adminPublicKey,
  seed: adminSeed,
  inputType: PROC_REMOVE_ROLE,
  inputBytes,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for confirmation ─────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify (poll until state is consistent) ───────────────────────────────────

let stillRegistered = true;
await pollUntil(async () => {
  const verifyBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, isFunc, targetBytes);
  stillRegistered = verifyBuf.readUInt8(0) !== 0;
  return !stillRegistered;
});
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
