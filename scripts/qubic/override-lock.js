/**
 * QSB OverrideLock — update the destination address and/or relayer fee of an
 * existing locked order. Only the original sender can call this.
 *
 * Usage:
 *   node scripts/qubic/override-lock.js --nonce <N> --to-address <addr> --relayer-fee <N> [options]
 *
 * Required:
 *   --nonce <N>           uint32 nonce of the existing locked order
 *   --to-address <addr>   New destination Solana address (max 64 chars)
 *   --relayer-fee <N>     New relayer fee in QU; must be < locked amount
 *
 * Options:
 *   --dry-run             Print intent without broadcasting
 *
 * Env:
 *   QUBIC_NODE_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               path to { sKey } JSON (must be the original sender)
 */

import { Buffer } from "node:buffer";
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
  bytesToQubicId,
  queryContractFunction,
  encodeGetLockedOrderInput,
  decodeGetLockedOrderOutput,
  FUNC_GET_LOCKED_ORDER,
} from "./utils.js";

const PROC_OVERRIDE_LOCK = 2;

// ── arg parsing ───────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv, { startIndex: 2 });
const isDryRun = parsed.dryRun === true;
const nonceArg = parsed.nonce ?? null;
const toAddressArg = parsed.toAddress ?? null;
const relayerFeeArg = parsed.relayerFee ?? null;

if (!nonceArg) {
  console.error("--nonce is required.\nUsage: node override-lock.js --nonce <N> --to-address <addr> --relayer-fee <N>");
  process.exit(1);
}
if (!toAddressArg) {
  console.error("--to-address is required.\nUsage: node override-lock.js --nonce <N> --to-address <addr> --relayer-fee <N>");
  process.exit(1);
}
if (relayerFeeArg === null) {
  console.error("--relayer-fee is required.\nUsage: node override-lock.js --nonce <N> --to-address <addr> --relayer-fee <N>");
  process.exit(1);
}

const nonce = parseInt(nonceArg, 10);
if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
  console.error(`Invalid --nonce: "${nonceArg}". Must be a uint32 (0..4294967295).`);
  process.exit(1);
}

const toAddress = toAddressArg.trim();
if (toAddress.length === 0 || toAddress.length > 64) {
  console.error(`Invalid --to-address: must be 1..64 characters.`);
  process.exit(1);
}

const relayerFee = parseInt(relayerFeeArg, 10);
if (!Number.isInteger(relayerFee) || relayerFee < 0) {
  console.error(`Invalid --relayer-fee: "${relayerFeeArg}". Must be a non-negative integer.`);
  process.exit(1);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { seed, publicKey, publicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the original sender keys file.");

console.log(`\n=== QSB OverrideLock ===`);
console.log(`  Caller      : ${publicId}`);
console.log(`  Bob Node    : ${bobUrl}`);
console.log(`  Nonce       : ${nonce}`);
console.log(`  New dest    : ${toAddress}`);
console.log(`  New relayer fee : ${relayerFee} QU`);
if (isDryRun) console.log(`  Mode        : DRY RUN`);

// ── pre-check: fetch existing order ──────────────────────────────────────────

const existingBuf = await queryContractFunction(
  bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_LOCKED_ORDER, encodeGetLockedOrderInput(nonce),
);
const { exists, order: existingOrder } = decodeGetLockedOrderOutput(existingBuf);

if (!exists) {
  console.error(`\n  No locked order found for nonce ${nonce}.`);
  process.exit(1);
}

const senderPublicId = await bytesToQubicId(existingOrder.sender);
const existingToAddr = Buffer.from(existingOrder.toAddress).toString("utf8").replace(/\0/g, "");
const existingHash = Buffer.from(existingOrder.orderHash).toString("hex");

console.log(`\n  Current state:`);
console.log(`    sender     : ${senderPublicId}`);
console.log(`    amount     : ${existingOrder.amount} QU`);
console.log(`    relayerFee : ${existingOrder.relayerFee} QU`);
console.log(`    toAddress  : ${existingToAddr}`);
console.log(`    orderHash  : ${existingHash}`);

// Only original sender can override
if (senderPublicId !== publicId) {
  console.error(`\n  Caller ${publicId} is not the original sender — only ${senderPublicId} can override this order.`);
  process.exit(1);
}

// relayerFee must be < locked amount
if (BigInt(relayerFee) >= existingOrder.amount) {
  console.error(`\n  Invalid --relayer-fee: ${relayerFee} must be strictly less than locked amount ${existingOrder.amount}.`);
  process.exit(1);
}

if (isDryRun) {
  console.log(`\nWould send OverrideLock tx (nonce=${nonce}, toAddress=${toAddress}, relayerFee=${relayerFee}).`);
  process.exit(0);
}

// ── build input (76 bytes) ────────────────────────────────────────────────────
//   [0..63]  uint8[64]  toAddress
//   [64..71] uint64     relayerFee
//   [72..75] uint32     nonce

const inputBytes = new Uint8Array(76);
const view = new DataView(inputBytes.buffer);
inputBytes.set(new TextEncoder().encode(toAddress.slice(0, 64)), 0);
view.setBigUint64(64, BigInt(relayerFee), true);
view.setUint32(72, nonce, true);

// ── send OverrideLock tx ──────────────────────────────────────────────────────

const { targetTick } = await buildAndBroadcastTx({
  seed,
  publicKey,
  inputType: PROC_OVERRIDE_LOCK,
  inputBytes,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for tick ─────────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify ────────────────────────────────────────────────────────────────────

let newHash = null;
let newToAddr = null;
let newRelayerFee = null;
await pollUntil(async () => {
  const buf = await queryContractFunction(
    bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_LOCKED_ORDER, encodeGetLockedOrderInput(nonce),
  );
  const { exists: still, order } = decodeGetLockedOrderOutput(buf);
  if (!still) return false;
  const updatedAddr = Buffer.from(order.toAddress).toString("utf8").replace(/\0/g, "");
  if (updatedAddr === toAddress && order.relayerFee === BigInt(relayerFee)) {
    newHash = Buffer.from(order.orderHash).toString("hex");
    newToAddr = updatedAddr;
    newRelayerFee = order.relayerFee;
    return true;
  }
  return false;
});

const hashChanged = newHash !== null && newHash !== existingHash;
console.log(`\n  Updated state:`);
console.log(`    relayerFee : ${existingOrder.relayerFee} → ${newRelayerFee ?? relayerFee} ${newRelayerFee !== null ? "✓" : "✗"}`);
console.log(`    toAddress  : ${existingToAddr} → ${newToAddr ?? toAddress} ${newToAddr !== null ? "✓" : "✗"}`);
console.log(`    orderHash  : ${existingHash}`);
console.log(`               → ${newHash ?? "(unchanged)"} ${hashChanged ? "✓" : "✗ (tx may have failed)"}`);
