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

import { randomInt } from "node:crypto";
import process from "node:process";
import {
  QSB_CONTRACT_INDEX,
  SOLANA_NETWORK_ID,
  LOCK_INPUT_TYPE,
  resolveNodeRpcUrl,
  resolveBobUrl,
  resolveQubicKeysPath,
  encodeLockInput,
  loadQubicKeys,
  createQubicIdPackage,
  getCurrentTick,
  getBalance,
  buildAndBroadcastTx,
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

const { publicKey, publicId } = await createQubicIdPackage(seed);

console.log(`\n=== QSB Lock (local testnet) ===`);
console.log(`  Node RPC    : ${nodeRpcUrl}`);
console.log(`  Bob Node    : ${bobUrl}`);
console.log(`  Contract    : ${QSB_CONTRACT_INDEX}`);
console.log(`  Amount      : ${amount} QU`);
console.log(`  Relayer fee : ${relayerFee} QU`);
console.log(`  To (Solana) : ${toAddress}`);
console.log(`  Nonce       : ${nonce}`);
console.log(`\n  Sender      : ${publicId}`);

const balance = await getBalance(nodeRpcUrl, publicId);
console.log(`  Balance     : ${balance ?? "unknown"} QU`);

if (balance !== null && Number(balance) < amount) {
  console.error(`\nInsufficient balance: ${balance} < ${amount}`);
  process.exit(1);
}

const inputBytes = encodeLockInput(amount, relayerFee, toAddress, SOLANA_NETWORK_ID, nonce);

const { txId, targetTick, result } = await buildAndBroadcastTx({
  publicKey,
  seed,
  inputType: LOCK_INPUT_TYPE,
  inputBytes,
  amount,
  nodeRpcUrl,
  bobUrl,
});

console.log(`  Broadcast   :`, JSON.stringify(result));

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
