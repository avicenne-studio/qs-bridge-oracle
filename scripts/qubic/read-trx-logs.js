/**
 * QSB — read and parse log events for a transaction accepted by Bob Node.
 *
 * Bob indexes transactions after they are executed on-chain. The script polls
 * until the tx is found and executed, then fetches and displays all log events.
 *
 * Usage:
 *   node scripts/qubic/read-trx-logs.js --tx <txHash> [options]
 *
 * Required:
 *   --tx <txHash>       Transaction hash to inspect
 *
 * Options:
 *   --epoch <N>         Epoch that contains the tx (default: current from Bob /status)
 *   --poll              Keep retrying until the tx is found and indexed
 *   --interval <ms>     Polling interval in ms (default: 3000)
 *   --max-retries <N>   Max polling attempts (default: 30)
 *
 * Env:
 *   QUBIC_RPC_URL  Bob Node (default: http://localhost:40420)
 */

import process from "node:process";
import { Buffer } from "node:buffer";
import { parseArgs } from "../shared/utils.js";
import {
  resolveBobUrl,
  getTxInfo,
  getBobStatus,
  fetchLogRange,
  parseQSBLogEntry,
  bytesToQubicId,
  QSB_LOG_LOCK,
  QSB_LOG_OVERRIDE_LOCK,
  QSB_LOG_UNLOCK,
  QSB_REASON,
} from "./utils.js";

// ── args ──────────────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv, { startIndex: 2 });

const txHash = parsed.tx ?? parsed._[0] ?? null;
const epochArg = parsed.epoch ? parseInt(parsed.epoch, 10) : null;
const doPoll = parsed.poll === true;
const intervalMs = parseInt(parsed.interval ?? "3000", 10);
const maxRetries = parseInt(parsed.maxRetries ?? "30", 10);

if (!txHash) {
  console.error("Usage: node read-trx-logs.js --tx <txHash> [--epoch <N>] [--poll]");
  process.exit(1);
}

const bobUrl = resolveBobUrl();

// ── helpers ───────────────────────────────────────────────────────────────────

function reasonLabel(code) {
  const entry = Object.entries(QSB_REASON).find(([, v]) => v === code);
  return entry ? entry[0] : `UNKNOWN(${code})`;
}

function hexId(buf) {
  return Buffer.from(buf).toString("hex");
}

function solanaAddr(buf) {
  return Buffer.from(buf).toString("ascii").replace(/\0+$/, "");
}

async function qubicAddr(buf) {
  return bytesToQubicId(buf instanceof Buffer ? new Uint8Array(buf) : buf);
}

async function printQSBEvent(ev) {
  const prefix = `  [log ${ev.logId}] `;
  const resultMark = ev.data.success ? "✓" : "✗";
  const reason = reasonLabel(ev.data.reasonCode);

  if (ev.event === "lock" || ev.event === "override-lock") {
    const label = ev.event === "lock" ? "Lock" : "OverrideLock";
    const from = await qubicAddr(ev.data.from);
    const to = solanaAddr(ev.data.to);
    console.log(`${prefix}${label} ${resultMark}`);
    console.log(`         from        : ${from}`);
    console.log(`         to (Solana) : ${to}`);
    console.log(`         amount      : ${ev.data.amount} QU`);
    console.log(`         relayerFee  : ${ev.data.relayerFee} QU`);
    console.log(`         networkOut  : ${ev.data.networkOut}`);
    console.log(`         nonce       : ${ev.data.nonce}`);
    console.log(`         orderHash   : ${hexId(ev.data.orderHash)}`);
    console.log(`         orderEra    : ${ev.data.orderEra}`);
    console.log(`         reasonCode  : ${reason}`);
  } else if (ev.event === "unlock") {
    const toAddr = await qubicAddr(ev.data.toAddress);
    const relayer = await qubicAddr(ev.data.relayer);
    console.log(`${prefix}Unlock ${resultMark}`);
    console.log(`         orderHash   : ${hexId(ev.data.orderHash)}`);
    console.log(`         to (Qubic)  : ${toAddr}`);
    console.log(`         amount      : ${ev.data.amount} QU`);
    console.log(`         relayerFee  : ${ev.data.relayerFee} QU`);
    console.log(`         relayer     : ${relayer}`);
    console.log(`         orderEra    : ${ev.data.orderEra}`);
    console.log(`         reasonCode  : ${reason}`);
  } else {
    console.log(`${prefix}QSB event type ${ev.logType} (unknown)`);
    console.log(`         content     : ${ev.data.contentHex}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== QSB Transaction Logs ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Tx hash  : ${txHash}`);

// Resolve epoch
let epoch = epochArg;
if (epoch === null) {
  const status = await getBobStatus(bobUrl).catch(() => null);
  epoch = status?.epoch ?? 0;
  console.log(`  Epoch    : ${epoch} (from Bob /status)`);
} else {
  console.log(`  Epoch    : ${epoch} (from --epoch arg)`);
}

// Poll for tx until found and executed
let txInfo = null;
const attempts = doPoll ? maxRetries : 1;

process.stdout.write(`\n  Fetching tx info`);
for (let i = 0; i < attempts; i++) {
  if (i > 0) {
    await new Promise((r) => setTimeout(r, intervalMs));
    process.stdout.write(".");
  }

  txInfo = await getTxInfo(bobUrl, txHash).catch(() => null);

  // Bob returns the tx object directly (with a `hash` field) when found,
  // or an object with `error` / missing `hash` when not yet indexed.
  if (txInfo?.hash) break;
}
process.stdout.write("\n");

if (!txInfo?.hash) {
  console.log(`\n  Tx not found in Bob's index.`);
  if (!doPoll) console.log(`  Tip: add --poll to keep retrying until Bob indexes it.`);
  process.exit(1);
}

console.log(`\n  Status`);
console.log(`    executed         : ${txInfo.executed ?? "(unknown)"}`);
console.log(`    tick             : ${txInfo.tick}`);
console.log(`    transactionIndex : ${txInfo.transactionIndex}`);
console.log(`    logIdFrom        : ${txInfo.logIdFrom}`);
console.log(`    logIdTo          : ${txInfo.logIdTo}`);

if (!txInfo.executed) {
  console.log(`\n  Tx was NOT executed (rejected or invalid input).`);
  process.exit(0);
}

if (txInfo.logIdFrom < 0 || txInfo.logIdTo < 0) {
  console.log(`\n  Tx executed but produced no log entries.`);
  process.exit(0);
}

// Fetch logs
const rawEntries = await fetchLogRange(bobUrl, epoch, txInfo.logIdFrom, txInfo.logIdTo);
console.log(`\n  Log entries : ${rawEntries.length} (ids ${txInfo.logIdFrom}..${txInfo.logIdTo})`);

let qsbCount = 0;
for (const entry of rawEntries) {
  const qsbEvent = parseQSBLogEntry(entry);
  if (qsbEvent) {
    qsbCount++;
    await printQSBEvent(qsbEvent);
  } else if (entry.ok === false) {
    console.log(`  [log ${entry.logId ?? "?"}] error: ${entry.error}`);
  } else {
    // Non-QSB log: show raw type + body summary
    const bodyKeys = Object.keys(entry.body ?? {}).join(", ");
    console.log(`  [log ${entry.logId}] type=${entry.type} body={${bodyKeys}}`);
  }
}

if (qsbCount === 0) {
  console.log(`  (no QSB events found in this tx's logs)`);
}
