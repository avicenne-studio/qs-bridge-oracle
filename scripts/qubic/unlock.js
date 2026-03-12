/**
 * unlock.js
 * Relay an order by submitting the Unlock procedure (id 3) on the Qubic contract.
 * This is what the oracle relayer does once enough signatures are collected.
 *
 * Usage:
 *   node scripts/qubic/unlock.js <order.json> <oracle-keys.json> [relayerSeed]
 *
 *   # Or:
 *   QUBIC_ORACLE_SEED=<oracleSeed> node scripts/qubic/unlock.js <order.json> <oracle-keys.json>
 *
 * order.json shape:
 * {
 *   "fromAddress": "<qubicPublicId>",
 *   "toAddress": "<qubicPublicId or hex32>",
 *   "amount": "1000",
 *   "relayerFee": "10",
 *   "networkOut": 1,
 *   "nonce": 12345,
 *   "tokenIn": "0",
 *   "tokenOut": "0",
 *   "networkIn": 0,
 *   "destinationChainId": 1
 * }
 *
 * oracle-keys.json: array of oracle seeds (strings)
 * [
 *   "seed1...",
 *   "seed2...",
 *   ...
 * ]
 *
 * The oracle signing each key produces a 64-byte Schnorr signature over K12(Order).
 * The relayer (caller) receives the relayerFee as reward.
 *
 * [BLOCKED: B2] Requires 6 oracle seeds from Seeker.
 * [BLOCKED: S1] UnlockInput byte layout must be confirmed.
 * [BLOCKED: T1.3] Oracle signatures must be computed using K12(Order) — Seeker must
 *                 confirm K12 implementation and order serialization.
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
// QubicHelper still needed for buildProcedureTx helper argument
import {
  PROCEDURE_IDS,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  encodeUnlockInput,
  encodeOrder,
  buildProcedureTx,
  broadcastTx,
  fetchCurrentTick,
  logSection,
  signWithK12,
} from "./utils.js";

async function signOrderWithK12(orderBytes, oracleSeed) {
  return signWithK12(orderBytes, oracleSeed);
}

async function main() {
  const orderPath = process.argv[2];
  const oracleKeysPath = process.argv[3];
  const relayerSeed = process.argv[4] ?? process.env.QUBIC_ORACLE_SEED;

  if (!orderPath || !oracleKeysPath) {
    throw new Error(
      "Usage: node scripts/qubic/unlock.js <order.json> <oracle-keys.json> [relayerSeed]"
    );
  }
  if (!relayerSeed) {
    throw new Error(
      "Relayer seed required (pass as arg 3 or set QUBIC_ORACLE_SEED).\n" +
        "  => Oracle seeds provided by Seeker (blocker B2)."
    );
  }

  const orderRaw = JSON.parse(await readFile(orderPath, "utf-8"));
  const oracleSeeds = JSON.parse(await readFile(oracleKeysPath, "utf-8"));

  const order = {
    fromAddress: orderRaw.fromAddress,
    toAddress: orderRaw.toAddress,
    tokenIn: BigInt(orderRaw.tokenIn ?? "0"),
    tokenOut: BigInt(orderRaw.tokenOut ?? "0"),
    amount: BigInt(orderRaw.amount),
    relayerFee: BigInt(orderRaw.relayerFee),
    destinationChainId: Number(orderRaw.destinationChainId ?? orderRaw.networkOut),
    networkIn: Number(orderRaw.networkIn ?? 0),
    networkOut: Number(orderRaw.networkOut),
    nonce: Number(orderRaw.nonce),
  };

  logSection("unlock", "Order");
  process.stdout.write(
    JSON.stringify(
      { ...order, amount: order.amount.toString(), relayerFee: order.relayerFee.toString() },
      null,
      2
    ) + "\n"
  );

  // Encode order to bytes (for signing)
  const orderBytes = encodeOrder(order);

  // Sign with each oracle key
  logSection("unlock", `Signing with ${oracleSeeds.length} oracle(s)`);
  const signatures = [];
  for (const seed of oracleSeeds) {
    const sig = await signOrderWithK12(orderBytes, seed);
    signatures.push(sig);
    process.stdout.write(`  oracle: ${sig.signer}\n`);
  }

  const inputBytes = encodeUnlockInput({ order, signatures });

  logSection("unlock", `Input: ${inputBytes.length} bytes`);

  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  const { signedBytes, publicId } = await buildProcedureTx(
    helper,
    relayerSeed,
    PROCEDURE_IDS.Unlock,
    inputBytes,
    tick
    // no invocation reward for Unlock
  );

  logSection("unlock", "Broadcasting");
  process.stdout.write(`  relayer: ${publicId}\n  tick: ${tick}\n`);

  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  process.stdout.write(
    `\nVerify with:\n  node scripts/qubic/poll-events.js\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
