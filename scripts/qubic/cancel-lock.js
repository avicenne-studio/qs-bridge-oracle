/**
 * cancel-lock.js
 * Cancel an active lock and refund the locked amount via CancelLock (procedure 4).
 *
 * Only the original lock sender can cancel.
 * No invocation reward needed.
 *
 * Usage:
 *   node scripts/qubic/cancel-lock.js --from <seed> --nonce <uint32>
 *
 * Example:
 *   node scripts/qubic/cancel-lock.js \
 *     --from slmvcerjvoncdlluydvilhuddusewxgoshuhgwelljzjykfllywlhon \
 *     --nonce 12345
 *
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set.
 * [BLOCKED: S1] CancelLockInput byte layout must be confirmed by Seeker.
 */

import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import {
  PROCEDURE_IDS,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  encodeCancelLockInput,
  buildProcedureTx,
  broadcastTx,
  fetchCurrentTick,
  logSection,
  parseArgs,
} from "./utils.js";

const helper = new QubicHelper();

async function main() {
  const args = parseArgs(process.argv, { startIndex: 2 });

  const fromSeed = args.from ?? process.env.QUBIC_SEED;
  const nonce = args.nonce != null ? Number(args.nonce) : null;

  if (!fromSeed || nonce == null) {
    throw new Error(
      "Usage: node scripts/qubic/cancel-lock.js --from <seed> --nonce <uint32>"
    );
  }

  const identity = await helper.createIdPackage(fromSeed);
  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("cancel-lock", "Inputs");
  process.stdout.write(
    JSON.stringify(
      { from: identity.publicId, nonce, tick, rpcUrl: QUBIC_RPC_URL },
      null,
      2
    ) + "\n"
  );

  const inputBytes = encodeCancelLockInput({ nonce });

  const { signedBytes } = await buildProcedureTx(
    helper,
    fromSeed,
    PROCEDURE_IDS.CancelLock,
    inputBytes,
    tick
  );

  logSection("cancel-lock", "Broadcasting");
  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  process.stdout.write(
    `\nVerify with:\n` +
      `  node scripts/qubic/get-locked-order.js --nonce ${nonce}   (should show exists: false)\n` +
      `  node scripts/qubic/poll-events.js   (should show CancelLock log)\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
