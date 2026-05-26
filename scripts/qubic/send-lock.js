/**
 * QSB Lock — submit a Lock transaction to QubicSolanaBridge.
 * Validates inputs, checks balance and duplicate nonce, broadcasts,
 * waits for the target tick, then retrieves and prints the order hash.
 *
 * Usage:
 *   node scripts/qubic/send-lock.js --amount <N> --to-address <addr> [options]
 *
 * Required:
 *   --amount <N>          Amount to lock in QU
 *   --to-address <addr>   Destination Solana address (max 64 chars)
 *
 * Options:
 *   --relayer-fee <N>     Relayer fee in QU; must be < amount (default: 0)
 *   --network-out <N>     Destination network ID (default: 2 = Solana)
 *   --nonce <N>           uint32 nonce; must be unused (default: random)
 *   --dry-run             Print intent without broadcasting
 *
 * Env:
 *   QUBIC_NODE_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               path to { sKey } JSON (sender)
 */

import { randomInt } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { parseArgs } from "../shared/utils.js";
import {
  QSB_CONTRACT_INDEX,
  SOLANA_NETWORK_ID,
  LOCK_INPUT_TYPE,
  resolveNodeRpcUrl,
  resolveBobUrl,
  requireQubicKeys,
  encodeLockInput,
  buildAndBroadcastTx,
  waitForTick,
  pollUntil,
  getBalance,
  queryContractFunction,
  encodeGetLockedOrderInput,
  decodeGetLockedOrderOutput,
  FUNC_GET_LOCKED_ORDER,
} from "./utils.js";

// ── arg parsing ───────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv, { startIndex: 2 });
const isDryRun = parsed.dryRun === true;
const amountArg = parsed.amount ?? null;
const relayerFeeArg = parsed.relayerFee ?? "0";
const toAddressArg = parsed.toAddress ?? null;
const networkOutArg = parsed.networkOut ?? String(SOLANA_NETWORK_ID);
const nonceArg = parsed.nonce ?? null;

if (!amountArg) {
  console.error("--amount is required.\nUsage: node send-lock.js --amount <N> --to-address <addr>");
  process.exit(1);
}
if (!toAddressArg) {
  console.error("--to-address is required.\nUsage: node send-lock.js --amount <N> --to-address <addr>");
  process.exit(1);
}

const amount = parseInt(amountArg, 10);
if (!Number.isInteger(amount) || amount <= 0) {
  console.error(`Invalid --amount: "${amountArg}". Must be a positive integer.`);
  process.exit(1);
}

const relayerFee = parseInt(relayerFeeArg, 10);
if (!Number.isInteger(relayerFee) || relayerFee < 0) {
  console.error(`Invalid --relayer-fee: "${relayerFeeArg}". Must be a non-negative integer.`);
  process.exit(1);
}
if (relayerFee >= amount) {
  console.error(`Invalid --relayer-fee: ${relayerFee} must be strictly less than --amount ${amount}.`);
  process.exit(1);
}

const networkOut = parseInt(networkOutArg, 10);
if (!Number.isInteger(networkOut) || networkOut < 1) {
  console.error(`Invalid --network-out: "${networkOutArg}". Must be a positive integer.`);
  process.exit(1);
}

const toAddress = toAddressArg.trim();
if (toAddress.length === 0 || toAddress.length > 64) {
  console.error(`Invalid --to-address: must be 1..64 characters.`);
  process.exit(1);
}

let nonce;
if (nonceArg !== null) {
  nonce = parseInt(nonceArg, 10);
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
    console.error(`Invalid --nonce: "${nonceArg}". Must be a uint32 (0..4294967295).`);
    process.exit(1);
  }
} else {
  nonce = randomInt(0, 0xffffffff);
}

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── setup ─────────────────────────────────────────────────────────────────────

const { seed, publicKey, publicId } =
  await requireQubicKeys("QUBIC_KEYS env var must point to the sender keys file.");

console.log(`\n=== QSB Lock ===`);
console.log(`  Caller      : ${publicId}`);
console.log(`  Bob Node    : ${bobUrl}`);
console.log(`  Amount      : ${amount} QU`);
console.log(`  Relayer fee : ${relayerFee} QU`);
console.log(`  To (Solana) : ${toAddress}`);
console.log(`  networkOut  : ${networkOut}`);
console.log(`  Nonce       : ${nonce}`);
if (isDryRun) console.log(`  Mode        : DRY RUN`);

// ── pre-check: balance ────────────────────────────────────────────────────────

const balance = await getBalance(nodeRpcUrl, publicId);
console.log(`\n  Balance (current) : ${balance ?? "unknown"} QU`);

if (balance !== null && BigInt(balance) < BigInt(amount)) {
  console.error(`\n  Insufficient balance: ${balance} < ${amount}`);
  process.exit(1);
}

// ── pre-check: duplicate nonce ────────────────────────────────────────────────

const existingBuf = await queryContractFunction(
  bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_LOCKED_ORDER, encodeGetLockedOrderInput(nonce),
);
const { exists: alreadyExists } = decodeGetLockedOrderOutput(existingBuf);
if (alreadyExists) {
  console.error(`\n  Nonce ${nonce} already has a locked order — use a different nonce.`);
  process.exit(1);
}

if (isDryRun) {
  console.log(`\nWould send Lock tx (input type ${LOCK_INPUT_TYPE}, amount=${amount}, nonce=${nonce}).`);
  process.exit(0);
}

// ── send Lock tx ──────────────────────────────────────────────────────────────

const inputBytes = encodeLockInput(amount, relayerFee, toAddress, networkOut, nonce);

const { targetTick } = await buildAndBroadcastTx({
  seed,
  publicKey,
  inputType: LOCK_INPUT_TYPE,
  inputBytes,
  amount,
  nodeRpcUrl,
  bobUrl,
});

// ── wait for tick ─────────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── verify ────────────────────────────────────────────────────────────────────

let orderHash = null;
await pollUntil(async () => {
  const buf = await queryContractFunction(
    bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_LOCKED_ORDER, encodeGetLockedOrderInput(nonce),
  );
  const { exists, order } = decodeGetLockedOrderOutput(buf);
  if (exists) {
    orderHash = Buffer.from(order.orderHash).toString("hex");
    return true;
  }
  return false;
});

console.log(`\n  Nonce      : ${nonce}`);
console.log(`  Order hash : ${orderHash ?? "(not found)"} ${orderHash ? "✓" : "✗ (tx may have failed — check balance, paused state, or nonce collision)"}`);
