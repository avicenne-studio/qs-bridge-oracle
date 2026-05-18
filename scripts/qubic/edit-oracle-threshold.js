/**
 * QSB EditOracleThreshold — update the oracle signature threshold percentage.
 * Must be called from the admin identity.
 *
 * Usage:
 *   node scripts/qubic/edit-oracle-threshold.js <newThreshold>
 *
 *   newThreshold: integer 1..100 (percent of oracles required to sign)
 *
 * Env:
 *   QUBIC_BROADCAST_RPC_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               path to admin { sKey } JSON
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
  queryContractFunction,
  decodeGetConfigOutput,
  FUNC_GET_CONFIG,
} from "./utils.js";

const PROC_EDIT_ORACLE_THRESHOLD = 11;

// ── arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const isDryRun = process.argv.includes("--dry-run");

if (args.length < 1) {
  console.error("Usage: node edit-oracle-threshold.js <newThreshold> [--dry-run]");
  console.error("  newThreshold: integer 1..100");
  process.exit(1);
}

const newThreshold = parseInt(args[0], 10);
if (!Number.isInteger(newThreshold) || newThreshold < 1 || newThreshold > 100) {
  console.error(`Invalid threshold: "${args[0]}". Must be an integer 1..100.`);
  process.exit(1);
}

const keysPath = resolveQubicKeysPath();
if (!keysPath) {
  console.error("QUBIC_KEYS env var must point to the admin keys file.");
  process.exit(1);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { sKey: seed } = await loadQubicKeys(keysPath);
const { publicKey, publicId } = await createQubicIdPackage(seed);

console.log(`\n=== QSB EditOracleThreshold ===`);
console.log(`  Caller        : ${publicId}`);
console.log(`  Bob Node      : ${bobUrl}`);
console.log(`  New threshold : ${newThreshold}%`);
if (isDryRun) console.log(`  Mode          : DRY RUN`);

// ── pre-check ─────────────────────────────────────────────────────────────────

const preBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
const preCfg = decodeGetConfigOutput(preBuf);

console.log(`\n  oracleThreshold (current) : ${preCfg.oracleThreshold}%`);

if (preCfg.oracleThreshold === newThreshold) {
  console.log(`\n  Already set to ${newThreshold}% — no transaction sent.`);
  process.exit(0);
}

if (isDryRun) {
  console.log(`\nWould send EditOracleThreshold tx: ${preCfg.oracleThreshold}% → ${newThreshold}%`);
  process.exit(0);
}

// ── send tx ───────────────────────────────────────────────────────────────────

// EditOracleThreshold_input: uint8 newThreshold (1 byte)
const inputBytes = new Uint8Array(1);
inputBytes[0] = newThreshold;

const tick = await getCurrentTick(nodeRpcUrl);
if (tick === 0) { console.error("Node down (tick=0)"); process.exit(1); }
const targetTick = tick + TICK_OFFSET;

const dest = new PublicKey(contractAddressBytes(QSB_CONTRACT_INDEX));
const payload = new DynamicPayload(inputBytes.length);
payload.setPayload(inputBytes);

const tx = new QubicTransaction()
  .setSourcePublicKey(new PublicKey(publicKey))
  .setDestinationPublicKey(dest)
  .setAmount(new Long(0))
  .setTick(targetTick)
  .setInputType(PROC_EDIT_ORACLE_THRESHOLD)
  .setInputSize(inputBytes.length)
  .setPayload(payload);

const builtTx = await tx.build(seed);
const txId = tx.getId();
console.log(`\n  TX ID  : ${txId}`);
console.log(`  Tick   : ${tick} → ${targetTick}`);

await broadcastViaBob(bobUrl, builtTx);

// ── wait for tick ─────────────────────────────────────────────────────────────

process.stdout.write("  Waiting...");
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if ((await getCurrentTick(nodeRpcUrl)) >= targetTick) break;
  process.stdout.write(".");
}
process.stdout.write("\n");

// ── verify ────────────────────────────────────────────────────────────────────

process.stdout.write("  Verifying");
let finalThreshold = preCfg.oracleThreshold;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
  finalThreshold = decodeGetConfigOutput(buf).oracleThreshold;
  if (finalThreshold === newThreshold) break;
  process.stdout.write(".");
}
process.stdout.write("\n");

const ok = finalThreshold === newThreshold;
console.log(`  oracleThreshold : ${preCfg.oracleThreshold}% → ${finalThreshold}% ${ok ? "✓" : "✗ (tx may have failed — caller may not be admin)"}`);
