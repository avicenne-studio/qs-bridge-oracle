/**
 * QSB Unpause — resumes the contract after a pause.
 * Can be called by admin or any registered pauser.
 *
 * Usage:
 *   node scripts/qubic/unpause.js [--dry-run]
 *
 * Env:
 *   QUBIC_BROADCAST_RPC_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               path to { sKey } JSON (admin or pauser)
 */

import process from "node:process";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
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

const PROC_UNPAUSE = 15;

const isDryRun = process.argv.includes("--dry-run");

const keysPath = resolveQubicKeysPath();
if (!keysPath) {
  console.error("QUBIC_KEYS env var must point to a keys file (admin or pauser).");
  process.exit(1);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

const { sKey: seed } = await loadQubicKeys(keysPath);
const { publicKey, publicId } = await createQubicIdPackage(seed);

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

const tick = await getCurrentTick(nodeRpcUrl);
if (tick === 0) { console.error("Node down (tick=0)"); process.exit(1); }
const targetTick = tick + TICK_OFFSET;

const dest = new PublicKey(contractAddressBytes(QSB_CONTRACT_INDEX));

const tx = new QubicTransaction()
  .setSourcePublicKey(new PublicKey(publicKey))
  .setDestinationPublicKey(dest)
  .setAmount(new Long(0))
  .setTick(targetTick)
  .setInputType(PROC_UNPAUSE)
  .setInputSize(0);

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
let paused = true;
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
  paused = decodeGetConfigOutput(buf).paused;
  if (!paused) break;
  process.stdout.write(".");
}
process.stdout.write("\n");

console.log(`  paused : ${paused} ${!paused ? "✓" : "✗ (tx may have failed — caller may not be admin or pauser)"}`);
