/**
 * QSB Unpause — resumes the contract after a pause.
 * Must be called from the admin identity (pausers can pause but not unpause).
 *
 * Usage:
 *   node scripts/qubic/unpause.js [--dry-run]
 *
 * Env:
 *   QUBIC_NODE_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL   Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS      path to admin { sKey } JSON
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

const PROC_UNPAUSE = 15;

const isDryRun = process.argv.includes("--dry-run");
const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

const { seed, publicKey, publicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the admin keys file.");

console.log(`\n=== QSB Unpause ===`);
console.log(`  Caller   : ${publicId}`);
console.log(`  Bob Node : ${bobUrl}`);
if (isDryRun) console.log(`  Mode     : DRY RUN`);

// ── pre-check ─────────────────────────────────────────────────────────────────

const preBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
const preCfg = decodeGetConfigOutput(preBuf);

console.log(`\n  paused (current) : ${preCfg.paused}`);

if (!preCfg.paused) {
  console.log(`\n  Contract is already unpaused — no transaction sent.`);
  process.exit(0);
}

if (isDryRun) {
  console.log(`\nWould send Unpause tx (input type ${PROC_UNPAUSE}, empty input).`);
  process.exit(0);
}

// ── send Unpause tx ───────────────────────────────────────────────────────────

const { targetTick } = await buildAndBroadcastTx({
  publicKey,
  seed,
  inputType: PROC_UNPAUSE,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for tick ─────────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify ────────────────────────────────────────────────────────────────────

let paused = true;
await pollUntil(async () => {
  const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
  paused = decodeGetConfigOutput(buf).paused;
  return !paused;
});

console.log(`  paused : ${paused} ${!paused ? "✓" : "✗ (tx may have failed — caller may not be admin)"}`);
