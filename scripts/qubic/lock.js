/**
 * lock.js
 * Submit a Lock procedure (id 1) on the real Qubic smart contract.
 * Locks QU tokens and emits a Lock log for the bridge to pick up.
 *
 * Usage:
 *   node scripts/qubic/lock.js \
 *     --from <seed>         # Qubic sender seed (55 lowercase letters) \
 *     --to <solanaAddress>  # Solana destination (base58 or hex) \
 *     --amount <quAmount>   # Amount to lock in QU (integer) \
 *     --relayer-fee <qu>    # Relayer fee in QU (must be < amount) \
 *     --nonce <uint32>      # Unique nonce (default: auto-generated) \
 *     --network-out <n>     # Destination chain ID (default: 1 = Solana)
 *
 * Example with test wallets:
 *   node scripts/qubic/lock.js \
 *     --from slmvcerjvoncdlluydvilhuddusewxgoshuhgwelljzjykfllywlhon \
 *     --to 11111111111111111111111111111111 \
 *     --amount 1000 \
 *     --relayer-fee 10
 *
 * IMPORTANT: The sender must hold enough QU to cover `amount` as invocation reward.
 * The contract requires: invocationReward >= amount (excess is refunded).
 *
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set (contract index 24 identity).
 * [BLOCKED: S1] LockInput byte layout must be confirmed by Seeker.
 */

import { randomInt } from "node:crypto";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import {
  PROCEDURE_IDS,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  encodeLockInput,
  buildProcedureTx,
  broadcastTx,
  fetchCurrentTick,
  logSection,
  parseArgs,
} from "./utils.js";

const helper = new QubicHelper();

// Solana network ID (as used by the contract)
const NETWORK_SOLANA = 1;

/**
 * Pad a 32-byte Solana address to 64 bytes for Qubic toAddress field.
 */
async function toAddress64(addressStr) {
  if (/^[0-9a-fA-F]{64}$/.test(addressStr)) {
    // 32-byte hex → pad to 64 bytes
    const buf = Buffer.alloc(64, 0);
    Buffer.from(addressStr, "hex").copy(buf);
    return buf;
  }
  // base58 Solana address → encode to 32 bytes → pad to 64
  const { getAddressEncoder, address } = await import("@solana/kit");
  const encoded = getAddressEncoder().encode(address(addressStr));
  const buf = Buffer.alloc(64, 0);
  Buffer.from(encoded).copy(buf);
  return buf;
}

async function main() {
  const args = parseArgs(process.argv, { startIndex: 2 });

  const fromSeed = args.from ?? process.env.QUBIC_SEED;
  const toAddressStr = args.to;
  const amount = BigInt(args.amount ?? "0");
  const relayerFee = BigInt(args.relayerFee ?? "0");
  const nonce = args.nonce != null ? Number(args.nonce) : randomInt(0, 0xffffffff);
  const networkOut = Number(args.networkOut ?? NETWORK_SOLANA);

  if (!fromSeed) {
    throw new Error(
      "Usage: node scripts/qubic/lock.js --from <seed> --to <solanaAddr> --amount <qu> --relayer-fee <qu>\n" +
        "  Test seeds available in generate-keys.js header."
    );
  }
  if (!toAddressStr) {
    throw new Error("--to <solanaAddress> is required");
  }
  if (amount <= 0n) {
    throw new Error("--amount must be > 0");
  }
  if (relayerFee >= amount) {
    throw new Error("--relayer-fee must be < amount");
  }

  const toAddrBytes = await toAddress64(toAddressStr);
  const identity = await helper.createIdPackage(fromSeed);
  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("lock", "Inputs");
  process.stdout.write(
    JSON.stringify(
      {
        from: identity.publicId,
        to: toAddressStr,
        amount: amount.toString(),
        relayerFee: relayerFee.toString(),
        nonce,
        networkOut,
        tick,
        rpcUrl: QUBIC_RPC_URL,
      },
      null,
      2
    ) + "\n"
  );

  const inputBytes = encodeLockInput({
    amount,
    relayerFee,
    toAddress: toAddrBytes,
    networkOut,
    nonce,
  });

  logSection("lock", "Encoded input");
  process.stdout.write(`  ${inputBytes.length} bytes: ${inputBytes.toString("hex")}\n`);

  // IMPORTANT: invocationReward must equal amount (the QU being locked)
  const { signedBytes } = await buildProcedureTx(
    helper,
    fromSeed,
    PROCEDURE_IDS.Lock,
    inputBytes,
    tick,
    amount // ← invocation reward = amount being locked
  );

  logSection("lock", "Broadcasting");
  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  process.stdout.write(
    `\nNonce used: ${nonce}\n` +
      `Verify with:\n` +
      `  node scripts/qubic/get-locked-order.js --nonce ${nonce}\n` +
      `  node scripts/qubic/poll-events.js\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
