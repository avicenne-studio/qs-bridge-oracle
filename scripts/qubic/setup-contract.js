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
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";
import {
  QSB_CONTRACT_INDEX,
  TICK_OFFSET,
  resolveNodeRpcUrl,
  resolveBobUrl,
  contractAddressBytes,
  loadQubicKeys,
  createQubicIdPackage,
  getCurrentTick,
  broadcastViaBob,
  qubicIdToBytes,
  queryContractFunction,
  decodeGetConfigOutput,
  FUNC_GET_CONFIG,
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

  const tick = await getCurrentTick(nodeRpcUrl);
  const targetTick = tick + TICK_OFFSET;

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

  const broadcastResult = await broadcastViaBob(bobUrl, builtTx);
  console.log(`  [${label}] tick=${targetTick} txId=${txId} → ${JSON.stringify(broadcastResult)}`);

  // Wait for tick to pass
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const currentTick = await getCurrentTick(nodeRpcUrl);
    if (currentTick >= targetTick) break;
    process.stdout.write(`\r    waiting tick ${currentTick}/${targetTick}...  `);
  }
  process.stdout.write("\r                                    \r");
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
