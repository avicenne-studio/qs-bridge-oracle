/**
 * QSB Lock — sends a Lock transaction to the QubicSolanaBridge contract
 * via the Core Lite node, then polls Bob Node for event confirmation.
 *
 * Usage:
 *   node scripts/qubic/send-lock.js [amount] [relayerFee] [toAddress] [seed]
 *
 * Defaults:
 *   amount     = 100000
 *   relayerFee = 1000
 *   toAddress  = 8axvTLqKVh7yqFr63Eo5g6ERzBbnGYEU2t4PKcGyYXSu
 *   seed       = (reads from QUBIC_KEYS file if set)
 *
 * Env:
 *   QUBIC_BROADCAST_RPC_URL  Core Lite node  (default: http://localhost:41841)
 *   QUBIC_RPC_URL            Bob Node        (default: http://localhost:40420)
 *   QUBIC_KEYS               path to { sKey, pKey? } JSON
 */

import { Buffer } from "node:buffer";
import { randomInt } from "node:crypto";
import process from "node:process";
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { Long } from "@qubic-lib/qubic-ts-library/dist/qubic-types/Long.js";
import {
  QSB_CONTRACT_INDEX,
  SOLANA_NETWORK_ID,
  LOCK_INPUT_TYPE,
  TICK_OFFSET,
  resolveNodeRpcUrl,
  resolveBobUrl,
  resolveQubicKeysPath,
  contractAddressBytes,
  encodeLockInput,
  loadQubicKeys,
  createQubicIdPackage,
  getCurrentTick,
  getBalance,
  broadcastViaBob,
} from "./utils.js";

const args = process.argv.slice(2);
const amount = parseInt(args[0] ?? "100000");
const relayerFee = parseInt(args[1] ?? "1000");
const toAddress = args[2] ?? "8axvTLqKVh7yqFr63Eo5g6ERzBbnGYEU2t4PKcGyYXSu";
const nonce = randomInt(0, 0xffffffff);

const nodeRpcUrl = resolveNodeRpcUrl();
const bobUrl = resolveBobUrl();

// Resolve seed: CLI arg > QUBIC_KEYS file > empty (generate-keys first)
let seed = args[3] ?? "";
const keysPath = resolveQubicKeysPath();
if (!seed && keysPath) {
  const keys = await loadQubicKeys(keysPath);
  seed = keys.sKey;
}

console.log(`\n=== QSB Lock (local testnet) ===`);
console.log(`  Node RPC    : ${nodeRpcUrl}`);
console.log(`  Bob Node    : ${bobUrl}`);
console.log(`  Contract    : ${QSB_CONTRACT_INDEX}`);
console.log(`  Amount      : ${amount} QU`);
console.log(`  Relayer fee : ${relayerFee} QU`);
console.log(`  To (Solana) : ${toAddress}`);
console.log(`  Nonce       : ${nonce}`);

const { publicKey, publicId } = await createQubicIdPackage(seed);
console.log(`\n  Sender      : ${publicId}`);

const balance = await getBalance(nodeRpcUrl, publicId);
console.log(`  Balance     : ${balance ?? "unknown"} QU`);

if (balance !== null && Number(balance) < amount) {
  console.error(`\nInsufficient balance: ${balance} < ${amount}`);
  process.exit(1);
}

const tick = await getCurrentTick(nodeRpcUrl);
if (tick === 0) {
  console.error("\nNode appears to be down (tick = 0)");
  process.exit(1);
}
const targetTick = tick + TICK_OFFSET;
console.log(`  Current tick: ${tick} → target ${targetTick}`);

const lockPayload = encodeLockInput(amount, relayerFee, toAddress, SOLANA_NETWORK_ID, nonce);

const dest = new PublicKey(contractAddressBytes(QSB_CONTRACT_INDEX));
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
const txId = tx.getId();

console.log(`\n  TX ID       : ${txId}`);

const broadcastResult = await broadcastViaBob(bobUrl, builtTx);
console.log(`  Broadcast   :`, JSON.stringify(broadcastResult));

// Poll for tick confirmation
console.log(`\nWaiting for confirmation...`);
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const currentTick = await getCurrentTick(nodeRpcUrl);
  if (currentTick >= targetTick) {
    console.log(`\nTick ${currentTick} reached (target was ${targetTick}).`);
    console.log(`Check tx status: curl ${bobUrl}/tx/${txId.toLowerCase()}`);
    break;
  }
  process.stdout.write(`\r  Waiting... (tick ${currentTick}/${targetTick})  `);
}

console.log("\nDone.");
