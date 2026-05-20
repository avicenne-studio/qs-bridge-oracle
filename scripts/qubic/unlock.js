/**
 * QSB Unlock — relay an inbound order by submitting oracle signatures.
 *
 * Builds the canonical Order struct, signs it with one or more oracle keys,
 * verifies the off-chain hash against the on-chain ComputeOrderHash, then
 * broadcasts the Unlock transaction and polls until the order is marked filled.
 *
 * Usage:
 *   node scripts/qubic/unlock.js --order <json-or-file> --oracle-keys <path> [options]
 *
 * Required:
 *   --order <json-or-file>   Order JSON string or path to a JSON file.
 *   --oracle-keys <path>     Oracle key file: { sKey } or [{ sKey }, ...]
 *
 * Order JSON fields:
 *   fromAddress  Qubic ID (60 chars) or 64-char hex  (default: zeros)
 *   toAddress    Qubic ID (60 chars) or 64-char hex  (default: zeros = NULL_ID)
 *   tokenIn      32-byte hex                          (default: zeros)
 *   tokenOut     32-byte hex                          (default: zeros)
 *   amount       uint64 number or string              (required)
 *   relayerFee   uint64 number or string              (default: 0)
 *   networkIn    uint32                               (default: 1 = Qubic)
 *   networkOut   uint32                               (default: 2 = Solana)
 *   nonce        uint32 → 4-byte LE in 32-byte array  OR  64-char hex
 *   orderEra     uint32                               (default: 0)
 *
 * Options:
 *   --dry-run    Compute hash, sign, print payouts — no broadcast.
 *
 * Env:
 *   QUBIC_BROADCAST_RPC_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               Relayer key file { sKey } (required unless --dry-run)
 */

import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { parseArgs } from "../shared/utils.js";
import {
  QSB_CONTRACT_INDEX,
  QUBIC_NETWORK_ID,
  SOLANA_NETWORK_ID,
  UNLOCK_INPUT_TYPE,
  resolveNodeRpcUrl,
  resolveBobUrl,
  requireQubicKeys,
  buildAndBroadcastTx,
  waitForTick,
  pollUntil,
  queryContractFunction,
  encodeOrderStruct,
  qubicIdToBytes,
  bytesToQubicId,
  FUNC_GET_CONFIG,
  FUNC_COMPUTE_ORDER_HASH,
  FUNC_IS_ORDER_FILLED,
  decodeGetConfigOutput,
  computeQsbOrderHashOffchain,
  signQsbOrder,
  encodeUnlockInput,
} from "./utils.js";

// ── Arg parsing ────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv, { startIndex: 2 });
const isDryRun = parsed.dryRun === true;
const orderArg = parsed.order ?? null;
const oracleKeysArg = parsed.oracleKeys ?? null;

if (!orderArg) {
  console.error(
    "--order is required.\n" +
    "Usage: node unlock.js --order <json-or-file> --oracle-keys <path>",
  );
  process.exit(1);
}
if (!oracleKeysArg) {
  console.error(
    "--oracle-keys is required.\n" +
    "Usage: node unlock.js --order <json-or-file> --oracle-keys <path>",
  );
  process.exit(1);
}

// ── Order JSON parsing ─────────────────────────────────────────────────────

let rawOrder;
try {
  rawOrder = JSON.parse(orderArg);
} catch {
  try {
    const content = await readFile(orderArg, "utf-8");
    rawOrder = JSON.parse(content);
  } catch {
    console.error(`Cannot parse --order as JSON or read as file: ${orderArg}`);
    process.exit(1);
  }
}

function hexOrIdToBytes(value) {
  if (!value) return new Uint8Array(32);
  const s = String(value).trim();
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return new Uint8Array(Buffer.from(hex, "hex"));
  return qubicIdToBytes(s);
}

function hexToBytes32(value) {
  if (!value) return new Uint8Array(32);
  const hex = String(value).startsWith("0x") ? String(value).slice(2) : String(value);
  const b = Buffer.from(hex.padEnd(64, "0"), "hex");
  const out = new Uint8Array(32);
  out.set(b.slice(0, 32));
  return out;
}

function nonceToBytes32(nonce) {
  if (typeof nonce === "string" && /^[0-9a-fA-F]{64}$/.test(nonce)) {
    return new Uint8Array(Buffer.from(nonce, "hex"));
  }
  const n = (Number(nonce) >>> 0);
  const out = new Uint8Array(32);
  out[0] = n & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 24) & 0xff;
  return out;
}

if (rawOrder.amount === undefined || rawOrder.amount === null) {
  console.error("Order JSON must include 'amount'.");
  process.exit(1);
}

const order = {
  fromAddress: hexOrIdToBytes(rawOrder.fromAddress),
  toAddress: hexOrIdToBytes(rawOrder.toAddress),
  tokenIn: hexToBytes32(rawOrder.tokenIn),
  tokenOut: hexToBytes32(rawOrder.tokenOut),
  amount: BigInt(rawOrder.amount),
  relayerFee: BigInt(rawOrder.relayerFee ?? 0),
  networkIn: rawOrder.networkIn ?? QUBIC_NETWORK_ID,
  networkOut: rawOrder.networkOut ?? SOLANA_NETWORK_ID,
  nonce: nonceToBytes32(rawOrder.nonce ?? 0),
  orderEra: rawOrder.orderEra ?? 0,
};

if (order.amount === 0n) {
  console.error("Invalid order.amount: must be > 0.");
  process.exit(1);
}
if (order.relayerFee >= order.amount) {
  console.error(`Invalid order.relayerFee ${order.relayerFee}: must be < amount ${order.amount}.`);
  process.exit(1);
}

// ── Oracle keys loading ────────────────────────────────────────────────────

let oracleKeysRaw;
try {
  const content = await readFile(oracleKeysArg, "utf-8");
  oracleKeysRaw = JSON.parse(content);
} catch {
  console.error(`Cannot read oracle keys file: ${oracleKeysArg}`);
  process.exit(1);
}

const oracleKeysList = Array.isArray(oracleKeysRaw) ? oracleKeysRaw : [oracleKeysRaw];
if (oracleKeysList.length === 0) {
  console.error("Oracle keys file must contain at least one key.");
  process.exit(1);
}
for (const [i, entry] of oracleKeysList.entries()) {
  if (typeof entry?.sKey !== "string" || entry.sKey.length === 0) {
    console.error(`Oracle keys entry #${i + 1}: missing or empty sKey.`);
    process.exit(1);
  }
}

// ── RPC setup ─────────────────────────────────────────────────────────────

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// ── Relayer keys (not needed for dry-run validation, but load early to fail fast) ──

let relayer = null;
if (!isDryRun) {
  relayer = await requireQubicKeys("QUBIC_KEYS env var must point to the relayer keys file.");
}

// ── Print header ──────────────────────────────────────────────────────────

const fromId = await bytesToQubicId(order.fromAddress);
const toId = await bytesToQubicId(order.toAddress);
const nonceHex = Buffer.from(order.nonce).toString("hex");

console.log(`\n=== QSB Unlock ===`);
console.log(`  Bob Node     : ${bobUrl}`);
console.log(`  Contract     : ${QSB_CONTRACT_INDEX}`);
console.log(`  fromAddress  : ${fromId}`);
console.log(`  toAddress    : ${toId}`);
console.log(`  amount       : ${order.amount} QU`);
console.log(`  relayerFee   : ${order.relayerFee} QU`);
console.log(`  networkIn    : ${order.networkIn}  networkOut: ${order.networkOut}`);
console.log(`  nonce        : ${nonceHex.slice(0, 16)}...`);
console.log(`  orderEra     : ${order.orderEra}`);
console.log(`  Oracles      : ${oracleKeysList.length} key(s)`);
if (isDryRun) console.log(`  Mode         : DRY RUN`);

// ── Fetch config (for expected payouts) ───────────────────────────────────

const configBuf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, null);
const config = decodeGetConfigOutput(configBuf);
const protocolFeeRecipientId = await bytesToQubicId(config.protocolFeeRecipient);
const oracleFeeRecipientId = await bytesToQubicId(config.oracleFeeRecipient);

// ── Compute order hash off-chain ──────────────────────────────────────────

const offchainHash = await computeQsbOrderHashOffchain(order);
const offchainHashHex = Buffer.from(offchainHash).toString("hex");

// ── Verify against on-chain ComputeOrderHash ──────────────────────────────

const orderStructBytes = encodeOrderStruct(order);
const onchainHashBuf = await queryContractFunction(
  bobUrl, QSB_CONTRACT_INDEX, FUNC_COMPUTE_ORDER_HASH, orderStructBytes,
);
const onchainHashHex = onchainHashBuf.slice(0, 32).toString("hex");

console.log(`\n  Order hash (off-chain) : ${offchainHashHex}`);
if (onchainHashHex === offchainHashHex) {
  console.log(`  Order hash (on-chain)  : ✓ matches`);
} else {
  console.error(`  Order hash (on-chain)  : ${onchainHashHex}`);
  console.error(`  MISMATCH: off-chain and on-chain hashes differ — check order fields.`);
  process.exit(1);
}

// ── Pre-check: already filled? ────────────────────────────────────────────

const filledBuf = await queryContractFunction(
  bobUrl, QSB_CONTRACT_INDEX, FUNC_IS_ORDER_FILLED, Buffer.from(offchainHash),
);
if (filledBuf.readUInt8(0) !== 0) {
  console.error(`\n  Order ${offchainHashHex} is already filled — replay rejected.`);
  process.exit(1);
}

// ── Sign with oracle keys ─────────────────────────────────────────────────

console.log(`\n  Signing with ${oracleKeysList.length} oracle key(s)...`);
const signatures = [];
for (const [i, entry] of oracleKeysList.entries()) {
  const sig = await signQsbOrder(order, entry.sKey);
  const signerIdStr = await bytesToQubicId(sig.signerPublicKey);
  console.log(`    [${i + 1}] ${signerIdStr}`);
  signatures.push(sig);
}

// ── Expected payout display ───────────────────────────────────────────────

const netAmount = order.amount - order.relayerFee;
const bpsFeeAmount = (netAmount * BigInt(config.bpsFee)) / 10000n;
const protocolFeeAmount = (bpsFeeAmount * BigInt(config.protocolFee)) / 100n;
const oracleFeeAmount = bpsFeeAmount >= protocolFeeAmount ? bpsFeeAmount - protocolFeeAmount : 0n;
const recipientAmount = netAmount >= bpsFeeAmount ? netAmount - bpsFeeAmount : 0n;

console.log(`\n  Expected payouts (bpsFee=${config.bpsFee} bps, protocolFee=${config.protocolFee}%):`);
console.log(`    Recipient  (toAddress)           : ${recipientAmount} QU`);
console.log(`    Relayer    (caller)               : ${order.relayerFee} QU`);
console.log(`    Protocol   (${protocolFeeRecipientId.slice(0, 12)}...) : ${protocolFeeAmount} QU`);
console.log(`    Oracle fee (${oracleFeeRecipientId.slice(0, 12)}...) : ${oracleFeeAmount} QU`);

if (isDryRun) {
  console.log(`\nDry run complete — no transaction broadcast.`);
  process.exit(0);
}

// ── Build and broadcast Unlock tx ─────────────────────────────────────────

const inputBytes = encodeUnlockInput(order, signatures);

// amount=0: any invocation reward is immediately refunded by the contract
const { targetTick } = await buildAndBroadcastTx({
  seed: relayer.seed,
  publicKey: relayer.publicKey,
  inputType: UNLOCK_INPUT_TYPE,
  inputBytes,
  amount: 0,
  nodeRpcUrl,
  bobUrl,
});

// ── Wait for tick ─────────────────────────────────────────────────────────

await waitForTick(nodeRpcUrl, targetTick);

// ── Verify: is-order-filled ───────────────────────────────────────────────

let filled = false;
await pollUntil(async () => {
  const buf = await queryContractFunction(
    bobUrl, QSB_CONTRACT_INDEX, FUNC_IS_ORDER_FILLED, Buffer.from(offchainHash),
  );
  filled = buf.readUInt8(0) !== 0;
  return filled;
});

console.log(`\n  Order hash : ${offchainHashHex}`);
console.log(`  Filled     : ${filled} ${filled ? "✓" : "✗ (tx may have failed — check sig count, oracle roles, threshold, or order era)"}`);
