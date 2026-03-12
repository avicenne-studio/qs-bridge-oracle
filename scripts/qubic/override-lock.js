/**
 * override-lock.js
 * Update the destination or relayer fee of an existing active lock
 * via OverrideLock (procedure 2).
 *
 * Only the original lock sender can call this.
 * Does not require a new invocation reward.
 *
 * Usage:
 *   node scripts/qubic/override-lock.js \
 *     --from <seed>         # Must be the original lock sender \
 *     --nonce <uint32>      # Nonce of the existing lock \
 *     --to <solanaAddress>  # New destination address \
 *     --relayer-fee <qu>    # New relayer fee (must be < original amount)
 *
 * Example:
 *   node scripts/qubic/override-lock.js \
 *     --from slmvcerjvoncdlluydvilhuddusewxgoshuhgwelljzjykfllywlhon \
 *     --nonce 12345 \
 *     --to 22222222222222222222222222222222 \
 *     --relayer-fee 20
 *
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set.
 * [BLOCKED: S1] OverrideLockInput byte layout must be confirmed by Seeker.
 */

import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import {
  PROCEDURE_IDS,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  encodeOverrideLockInput,
  buildProcedureTx,
  broadcastTx,
  fetchCurrentTick,
  logSection,
  parseArgs,
} from "./utils.js";

const helper = new QubicHelper();

async function toAddress64(addressStr) {
  if (/^[0-9a-fA-F]{64}$/.test(addressStr)) {
    const buf = Buffer.alloc(64, 0);
    Buffer.from(addressStr, "hex").copy(buf);
    return buf;
  }
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
  const nonce = args.nonce != null ? Number(args.nonce) : null;
  const relayerFee = BigInt(args.relayerFee ?? "0");

  if (!fromSeed || nonce == null || !toAddressStr) {
    throw new Error(
      "Usage: node scripts/qubic/override-lock.js --from <seed> --nonce <n> --to <addr> --relayer-fee <qu>"
    );
  }

  const toAddrBytes = await toAddress64(toAddressStr);
  const identity = await helper.createIdPackage(fromSeed);
  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("override-lock", "Inputs");
  process.stdout.write(
    JSON.stringify(
      {
        from: identity.publicId,
        nonce,
        to: toAddressStr,
        relayerFee: relayerFee.toString(),
        tick,
        rpcUrl: QUBIC_RPC_URL,
      },
      null,
      2
    ) + "\n"
  );

  const inputBytes = encodeOverrideLockInput({
    toAddress: toAddrBytes,
    relayerFee,
    nonce,
  });

  const { signedBytes } = await buildProcedureTx(
    helper,
    fromSeed,
    PROCEDURE_IDS.OverrideLock,
    inputBytes,
    tick
    // no invocation reward
  );

  logSection("override-lock", "Broadcasting");
  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  process.stdout.write(
    `\nVerify with:\n  node scripts/qubic/get-locked-order.js --nonce ${nonce}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
