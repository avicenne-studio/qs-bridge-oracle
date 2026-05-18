/**
 * QSB EditFeeParameters — update fee rates and/or fee recipient addresses.
 * Must be called from the admin identity.
 *
 * Usage:
 *   node scripts/qubic/edit-fee-parameters.js [options]
 *
 * Options (all optional; omitted fields are left unchanged):
 *   --bps-fee <N>                    Basis points fee, 1..1000 (max 10%)
 *   --protocol-fee <N>               Protocol share of bps fee, 1..100 (%)
 *   --protocol-fee-recipient <ID>    Qubic public ID for protocol fees
 *   --oracle-fee-recipient <ID>      Qubic public ID for oracle fees
 *
 * At least one option must be provided.
 *
 * Env:
 *   QUBIC_BROADCAST_RPC_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               path to admin { sKey } JSON
 */

import process from "node:process";
import { parseArgs } from "../shared/utils.js";
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

const PROC_EDIT_FEE_PARAMETERS = 16;
const MAX_BPS_FEE = 1000;
const MAX_PROTOCOL_FEE = 100;

// ── arg parsing ───────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv, { startIndex: 2 });
const isDryRun = parsed.dryRun === true;
const bpsFeeArg            = parsed.bpsFee             ?? null;
const protocolFeeArg       = parsed.protocolFee        ?? null;
const protocolRecipientArg = parsed.protocolFeeRecipient ?? null;
const oracleRecipientArg   = parsed.oracleFeeRecipient   ?? null;

if (!bpsFeeArg && !protocolFeeArg && !protocolRecipientArg && !oracleRecipientArg) {
  console.error("At least one option must be provided.");
  console.error("  --bps-fee <1..1000>               Basis points fee");
  console.error("  --protocol-fee <1..100>           Protocol share of bps fee (%)");
  console.error("  --protocol-fee-recipient <ID>     Qubic ID for protocol fees");
  console.error("  --oracle-fee-recipient <ID>       Qubic ID for oracle fees");
  process.exit(1);
}

// Parse and validate numeric flags
let bpsFee = 0;
if (bpsFeeArg !== null) {
  bpsFee = parseInt(bpsFeeArg, 10);
  if (!Number.isInteger(bpsFee) || bpsFee < 1 || bpsFee > MAX_BPS_FEE) {
    console.error(`Invalid --bps-fee: "${bpsFeeArg}". Must be 1..${MAX_BPS_FEE}.`);
    process.exit(1);
  }
}

let protocolFee = 0;
if (protocolFeeArg !== null) {
  protocolFee = parseInt(protocolFeeArg, 10);
  if (!Number.isInteger(protocolFee) || protocolFee < 1 || protocolFee > MAX_PROTOCOL_FEE) {
    console.error(`Invalid --protocol-fee: "${protocolFeeArg}". Must be 1..${MAX_PROTOCOL_FEE}.`);
    process.exit(1);
  }
}

// Parse recipient IDs (zero bytes = don't update)
const protocolFeeRecipientBytes = protocolRecipientArg ? qubicIdToBytes(protocolRecipientArg) : new Uint8Array(32);
const oracleFeeRecipientBytes   = oracleRecipientArg   ? qubicIdToBytes(oracleRecipientArg)   : new Uint8Array(32);

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { seed, publicKey, publicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the admin keys file.");

console.log(`\n=== QSB EditFeeParameters ===`);
console.log(`  Caller   : ${publicId}`);
console.log(`  Bob Node : ${bobUrl}`);
if (bpsFeeArg)            console.log(`  bpsFee                : ${bpsFee}`);
if (protocolFeeArg)       console.log(`  protocolFee           : ${protocolFee}%`);
if (protocolRecipientArg) console.log(`  protocolFeeRecipient  : ${protocolRecipientArg}`);
if (oracleRecipientArg)   console.log(`  oracleFeeRecipient    : ${oracleRecipientArg}`);
if (isDryRun) console.log(`  Mode     : DRY RUN`);

// ── pre-check ─────────────────────────────────────────────────────────────────

const preBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
const preCfg = decodeGetConfigOutput(preBuf);
const preProtocolId = await bytesToQubicId(preCfg.protocolFeeRecipient);
const preOracleId   = await bytesToQubicId(preCfg.oracleFeeRecipient);

console.log(`\n  Current state:`);
console.log(`    bpsFee               : ${preCfg.bpsFee}`);
console.log(`    protocolFee          : ${preCfg.protocolFee}%`);
console.log(`    protocolFeeRecipient : ${preProtocolId}`);
console.log(`    oracleFeeRecipient   : ${preOracleId}`);

if (isDryRun) {
  console.log(`\nWould send EditFeeParameters tx.`);
  process.exit(0);
}

// ── build input ───────────────────────────────────────────────────────────────

// EditFeeParameters_input layout (72 bytes, little-endian):
//   [0..31]  id   protocolFeeRecipient  (zero = unchanged)
//   [32..63] id   oracleFeeRecipient    (zero = unchanged)
//   [64..67] u32  bpsFee                (0 = unchanged)
//   [68..71] u32  protocolFee           (0 = unchanged)
const inputBytes = new Uint8Array(72);
const view = new DataView(inputBytes.buffer);
inputBytes.set(protocolFeeRecipientBytes, 0);
inputBytes.set(oracleFeeRecipientBytes, 32);
view.setUint32(64, bpsFee, true);
view.setUint32(68, protocolFee, true);

// ── send tx ───────────────────────────────────────────────────────────────────

const { targetTick } = await buildAndBroadcastTx({
  publicKey,
  seed,
  inputType: PROC_EDIT_FEE_PARAMETERS,
  inputBytes,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for tick ─────────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify ────────────────────────────────────────────────────────────────────

let finalCfg = preCfg;
await pollUntil(async () => {
  const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
  finalCfg = decodeGetConfigOutput(buf);
  const bpsOk   = !bpsFeeArg     || finalCfg.bpsFee      === bpsFee;
  const protoOk = !protocolFeeArg || finalCfg.protocolFee === protocolFee;
  return bpsOk && protoOk;
});

const finalProtocolId = await bytesToQubicId(finalCfg.protocolFeeRecipient);
const finalOracleId   = await bytesToQubicId(finalCfg.oracleFeeRecipient);

console.log(`\n  Final state:`);
if (bpsFeeArg) {
  const ok = finalCfg.bpsFee === bpsFee;
  console.log(`    bpsFee               : ${preCfg.bpsFee} → ${finalCfg.bpsFee} ${ok ? "✓" : "✗"}`);
}
if (protocolFeeArg) {
  const ok = finalCfg.protocolFee === protocolFee;
  console.log(`    protocolFee          : ${preCfg.protocolFee}% → ${finalCfg.protocolFee}% ${ok ? "✓" : "✗"}`);
}
if (protocolRecipientArg) {
  const ok = finalProtocolId === protocolRecipientArg;
  console.log(`    protocolFeeRecipient : ${preProtocolId} → ${finalProtocolId} ${ok ? "✓" : "✗"}`);
}
if (oracleRecipientArg) {
  const ok = finalOracleId === oracleRecipientArg;
  console.log(`    oracleFeeRecipient   : ${preOracleId} → ${finalOracleId} ${ok ? "✓" : "✗"}`);
}

const allOk =
  (!bpsFeeArg            || finalCfg.bpsFee      === bpsFee) &&
  (!protocolFeeArg       || finalCfg.protocolFee  === protocolFee) &&
  (!protocolRecipientArg || finalProtocolId        === protocolRecipientArg) &&
  (!oracleRecipientArg   || finalOracleId          === oracleRecipientArg);

if (!allOk) console.log(`\n  ✗ One or more fields did not update — tx may have failed (caller may not be admin, or values out of range)`);
