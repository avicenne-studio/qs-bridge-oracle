/**
 * QSB local testnet contract setup — registers all oracles and pausers.
 *
 * Reads oracle/pauser public IDs from .temp/ fixture files and calls
 * AddRole for each via the admin key.
 *
 * Usage:
 *   node scripts/qubic/setup-contract.js [--dry-run]
 *
 * Env:
 *   QUBIC_BOB_URL  Bob Node  (default: http://localhost:40420)
 *   QUBIC_KEYS     path to admin keys JSON (default: .temp/qubic-admin.keys.json)
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  QSB_CONTRACT_INDEX,
  resolveNodeRpcUrl,
  resolveBobUrl,
  loadQubicKeys,
  createQubicIdPackage,
  buildAndBroadcastTx,
  waitForTick,
  qubicIdToBytes,
  queryContractFunction,
  decodeGetConfigOutput,
  FUNC_GET_CONFIG,
  getCurrentTick,
} from "./utils.js";

const PROC_ADD_ROLE = 12;
const ROLE_ORACLE = 1;
const ROLE_PAUSER = 2;

const isDryRun = process.argv.includes("--dry-run");
const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

const adminKeysPath = process.env.QUBIC_KEYS ?? resolve(".temp/qubic-admin.keys.json");
if (!existsSync(adminKeysPath)) {
  console.error(`Admin keys not found: ${adminKeysPath}`);
  process.exit(1);
}
const { sKey: adminSeed } = await loadQubicKeys(adminKeysPath);
const { publicKey: adminPublicKey, publicId: adminPublicId } = await createQubicIdPackage(adminSeed);

// Load oracle public IDs from .temp/oracle-N.qubic.keys.json
const oracleIds = [];
for (let i = 1; i <= 6; i++) {
  const path = resolve(`.temp/oracle-${i}.qubic.keys.json`);
  if (!existsSync(path)) { console.warn(`  Missing ${path}, skipping`); continue; }
  const { pKey } = JSON.parse(await readFile(path, "utf-8"));
  oracleIds.push({ i, pKey });
}

// Load pauser public ID
const pauserPath = resolve(".temp/qubic-pauser.keys.json");
const pauserIds = [];
if (existsSync(pauserPath)) {
  const { pKey } = JSON.parse(await readFile(pauserPath, "utf-8"));
  pauserIds.push(pKey);
}

const roles = [
  ...oracleIds.map(({ i, pKey }) => ({ label: `oracle-${i}`, publicId: pKey, role: ROLE_ORACLE })),
  ...pauserIds.map((pKey) => ({ label: "pauser", publicId: pKey, role: ROLE_PAUSER })),
];

console.log(`\n=== QSB Contract Setup (local testnet) ===`);
console.log(`  Bob Node    : ${bobUrl}`);
console.log(`  Admin       : ${adminPublicId}`);
console.log(`  Accounts    : ${roles.length} (${oracleIds.length} oracles, ${pauserIds.length} pausers)`);
if (isDryRun) console.log(`  Mode        : DRY RUN`);

// Print current config
const configBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, null);
const config = decodeGetConfigOutput(configBuf);
console.log(`\n  Current oracleCount : ${config.oracleCount}`);
console.log(`  Current pauserCount : ${config.pauserCount}`);

if (isDryRun) {
  console.log(`\nWould call AddRole for:`);
  for (const { label, publicId, role } of roles) {
    console.log(`  ${label} (role=${role}): ${publicId}`);
  }
  process.exit(0);
}

// AddRole_input: id account (32 bytes) + uint8 role (1 byte) + padding[7]
async function sendAddRole(publicId, role, label) {
  const inputBytes = new Uint8Array(40);
  inputBytes.set(qubicIdToBytes(publicId), 0);
  inputBytes[32] = role;

  const { txId, targetTick, result } = await buildAndBroadcastTx({
    publicKey: adminPublicKey,
    seed: adminSeed,
    inputType: PROC_ADD_ROLE,
    inputBytes,
    nodeRpcUrl,
    bobUrl,
    silent: true,
  });
  console.log(`  [${label}] tick=${targetTick} txId=${txId} → ${JSON.stringify(result)}`);

  await waitForTick(nodeRpcUrl, targetTick);
}

console.log(`\nRegistering roles...`);
for (const { label, publicId, role } of roles) {
  await sendAddRole(publicId, role, label);
}

// Wait one more tick so all state writes from the last tx are committed
const lastTick = await getCurrentTick(nodeRpcUrl);
const waitUntil = lastTick + 1;
process.stdout.write(`\nWaiting for tick ${waitUntil} before final check...`);
while (true) {
  await new Promise((r) => setTimeout(r, 2000));
  if ((await getCurrentTick(nodeRpcUrl)) >= waitUntil) break;
}
process.stdout.write(" done.\n");

// Final config check
const finalBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, null);
const finalConfig = decodeGetConfigOutput(finalBuf);
console.log(`\n=== Final state ===`);
console.log(`  oracleCount : ${finalConfig.oracleCount}`);
console.log(`  pauserCount : ${finalConfig.pauserCount}`);
console.log(`  threshold   : ${finalConfig.oracleThreshold}%`);
console.log(`\nDone.`);
