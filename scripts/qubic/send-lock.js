/**
 * QSB Lock — sends a Lock transaction to the QubicSolanaBridge contract.
 *
 * Usage:
 *   node scripts/send-qubic-lock.js [amount] [relayerFee] [toAddress] [seed]
 *
 * Defaults:
 *   amount     = 1000
 *   relayerFee = 10
 *   toAddress  = Solana address from SOLANA_KEYS fixture
 *   seed       =
 *
 * Example:
 *   node scripts/send-qubic-lock.js 5000 50 8axvTLqKVh7yqFr63Eo5g6ERzBbnGYEU2t4PKcGyYXSu
 */

import { Buffer } from "node:buffer";
import { randomInt } from "node:crypto";
import process from "node:process";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";

const DEFAULT_SEED = "";
const RPC_URL = process.env.QUBIC_BROADCAST_RPC_URL || "http://34.163.36.179:41841";
const CONTRACT_INDEX = 27;
const LOCK_INPUT_TYPE = 1;
const TICK_OFFSET = 5;
const SOLANA_NETWORK_OUT = 2;

async function getCurrentTick() {
  const res = await fetch(`${RPC_URL}/live/v1/tick-info`);
  if (!res.ok) throw new Error(`tick-info HTTP ${res.status}`);
  const body = await res.json();
  return body.tick;
}

async function getBalance(publicId) {
  const res = await fetch(`${RPC_URL}/live/v1/balances/${publicId}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body.balance?.balance ?? null;
}

function contractDestination(index) {
  const buf = new Uint8Array(32);
  let v = BigInt(index);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

function buildLockPayload(amount, relayerFee, toAddress, networkOut, nonce) {
  const buf = new ArrayBuffer(88);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setBigUint64(0, BigInt(amount), true);
  view.setBigUint64(8, BigInt(relayerFee), true);

  // toAddress: 64 bytes zero-padded (ASCII-encode the Solana address)
  const addrBytes = new TextEncoder().encode(toAddress.slice(0, 64));
  bytes.set(addrBytes, 16);

  view.setUint32(80, networkOut, true);
  view.setUint32(84, nonce, true);

  return bytes;
}

const args = process.argv.slice(2);
const amount = parseInt(args[0] ?? "100000");
const relayerFee = parseInt(args[1] ?? "1000");
const toAddress = args[2] ?? "8axvTLqKVh7yqFr63Eo5g6ERzBbnGYEU2t4PKcGyYXSu";
const seed = args[3] ?? DEFAULT_SEED;
const nonce = randomInt(0, 0xffffffff);

console.log(`\n=== QSB Lock (testnet) ===`);
console.log(`  RPC         : ${RPC_URL}`);
console.log(`  Contract    : ${CONTRACT_INDEX}`);
console.log(`  Amount      : ${amount} QU`);
console.log(`  Relayer fee : ${relayerFee} QU`);
console.log(`  To (Solana) : ${toAddress}`);
console.log(`  Nonce       : ${nonce}`);

const helper = new QubicHelper();
const { publicKey, publicId } = await helper.createIdPackage(seed);
console.log(`\n  Sender      : ${publicId}`);

const balance = await getBalance(publicId);
console.log(`  Balance     : ${balance ?? "unknown"} QU`);

if (balance !== null && Number(balance) < amount) {
  console.error(`\nInsufficient balance: ${balance} < ${amount}`);
  process.exit(1);
}

const tick = await getCurrentTick();
if (tick === 0) {
  console.error("\nTestnet appears to be down (tick = 0)");
  process.exit(1);
}
const targetTick = tick + TICK_OFFSET;
console.log(`  Current tick: ${tick} → target ${targetTick}`);

// Build Lock payload (88 bytes)
const lockPayload = buildLockPayload(amount, relayerFee, toAddress, SOLANA_NETWORK_OUT, nonce);

const dest = new PublicKey(contractDestination(CONTRACT_INDEX));
const payload = new DynamicPayload(lockPayload.length);
payload.setPayload(lockPayload);

const tx = new QubicTransaction()
  .setSourcePublicKey(new PublicKey(publicKey))
  .setDestinationPublicKey(dest)
  .setAmount(new Long(amount))
  .setTick(targetTick)
  .setInputType(LOCK_INPUT_TYPE)
  .setInputSize(lockPayload.length)
  .setPayload(payload);

const builtTx = await tx.build(seed);
const base64Data = Buffer.from(builtTx).toString("base64");
const txId = tx.getId();

console.log(`\n  TX ID       : ${txId}`);

// Broadcast
const broadcastRes = await fetch(`${RPC_URL}/live/v1/broadcast-transaction`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ encodedTransaction: base64Data }),
});

if (!broadcastRes.ok) {
  const errBody = await broadcastRes.text().catch(() => "");
  console.error(`\nBroadcast failed: HTTP ${broadcastRes.status}\n${errBody}`);
  process.exit(1);
}

const broadcastBody = await broadcastRes.json();
console.log(`  Broadcast   :`, JSON.stringify(broadcastBody));

// Poll for confirmation
console.log(`\nWaiting for confirmation...`);
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const currentTick = await getCurrentTick();
  if (currentTick >= targetTick) {
    console.log(`\nTick ${currentTick} reached (target was ${targetTick}).`);
    console.log(`Lock transaction should be processed.`);

    // Check if indexer captured it
    const indexerUrl = process.env.QUBIC_RPC_URL || "http://34.163.36.179:3002";
    try {
      const eventsRes = await fetch(`${indexerUrl}/events`);
      if (eventsRes.ok) {
        const events = await eventsRes.json();
        const found = events.find((e) => e.trxHash === txId.toLowerCase());
        if (found) {
          console.log(`\nIndexer captured the Lock event:`);
          console.log(JSON.stringify(found, null, 2));
        } else {
          console.log(`\nEvent not yet indexed. Check manually:`);
          console.log(`  curl ${indexerUrl}/events`);
        }
      }
    } catch {
      // indexer not available
    }
    break;
  }
  process.stdout.write(`\r  Waiting... (tick ${currentTick}/${targetTick})  `);
}

console.log("\nDone.");
