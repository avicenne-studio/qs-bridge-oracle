/**
 * QSB TransferAdmin — transfer contract admin rights to a new identity.
 * Must be called from the current admin identity.
 * The new admin address must not be the zero address.
 *
 * Usage:
 *   node scripts/qubic/transfer-admin.js <newAdminPublicId> [--dry-run]
 *
 *   newAdminPublicId: 60-char Qubic public ID of the new admin
 *
 * Env:
 *   QUBIC_NODE_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL   Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS      path to current admin { sKey } JSON
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
  bytesToQubicId,
  queryContractFunction,
  decodeGetConfigOutput,
  FUNC_GET_CONFIG,
} from "./utils.js";

const PROC_TRANSFER_ADMIN = 10;

// ── arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const isDryRun = process.argv.includes("--dry-run");

if (args.length < 1) {
  console.error("Usage: node transfer-admin.js <newAdminPublicId> [--dry-run]");
  console.error("  newAdminPublicId: 60-char Qubic public ID");
  process.exit(1);
}

const newAdminId = args[0].trim();
if (newAdminId.length !== 60) {
  console.error(`Invalid public ID: "${newAdminId}". Must be 60 characters.`);
  process.exit(1);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { seed, publicKey, publicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the current admin keys file.");

console.log(`\n=== QSB TransferAdmin ===`);
console.log(`  Caller    : ${publicId}`);
console.log(`  Bob Node  : ${bobUrl}`);
console.log(`  New admin : ${newAdminId}`);
if (isDryRun) console.log(`  Mode      : DRY RUN`);

// ── pre-check ─────────────────────────────────────────────────────────────────

const preBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
const preCfg = decodeGetConfigOutput(preBuf);
const currentAdminId = await bytesToQubicId(preCfg.admin);

console.log(`\n  admin (current) : ${currentAdminId}`);

if (currentAdminId === newAdminId) {
  console.log(`\n  Already the admin — no transaction sent.`);
  process.exit(0);
}

if (isDryRun) {
  console.log(`\nWould send TransferAdmin tx: ${currentAdminId} → ${newAdminId}`);
  process.exit(0);
}

// ── send tx ───────────────────────────────────────────────────────────────────

// TransferAdmin_input: id newAdmin (32 bytes)
const inputBytes = qubicIdToBytes(newAdminId);

const { targetTick } = await buildAndBroadcastTx({
  publicKey,
  seed,
  inputType: PROC_TRANSFER_ADMIN,
  inputBytes,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for tick ─────────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify ────────────────────────────────────────────────────────────────────

let finalAdminId = currentAdminId;
await pollUntil(async () => {
  const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
  const cfg = decodeGetConfigOutput(buf);
  finalAdminId = await bytesToQubicId(cfg.admin);
  return finalAdminId === newAdminId;
});

const ok = finalAdminId === newAdminId;
console.log(`  admin : ${currentAdminId} → ${finalAdminId} ${ok ? "✓" : "✗ (tx may have failed — caller may not be current admin)"}`);
