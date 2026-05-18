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
import {
  QSB_CONTRACT_INDEX,
  resolveNodeRpcUrl,
  resolveBobUrl,
  requireQubicKeys,
  buildAndBroadcastTx,
  waitForTick,
  pollUntil,
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

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { seed, publicKey, publicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the admin keys file.");

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

const { targetTick } = await buildAndBroadcastTx({
  publicKey,
  seed,
  inputType: PROC_EDIT_ORACLE_THRESHOLD,
  inputBytes,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for tick ─────────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify ────────────────────────────────────────────────────────────────────

let finalThreshold = preCfg.oracleThreshold;
await pollUntil(async () => {
  const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
  finalThreshold = decodeGetConfigOutput(buf).oracleThreshold;
  return finalThreshold === newThreshold;
});

const ok = finalThreshold === newThreshold;
console.log(`  oracleThreshold : ${preCfg.oracleThreshold}% → ${finalThreshold}% ${ok ? "✓" : "✗ (tx may have failed — caller may not be admin)"}`);
