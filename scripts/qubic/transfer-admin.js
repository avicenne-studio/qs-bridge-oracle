/**
 * transfer-admin.js
 * Transfer admin role to a new address via TransferAdmin (procedure 10).
 *
 * Usage:
 *   node scripts/qubic/transfer-admin.js <newAdminPublicId> [currentAdminSeed]
 *   QUBIC_ADMIN_SEED=<seed> node scripts/qubic/transfer-admin.js <newAdminPublicId>
 *
 * [BLOCKED: B1] Requires the seed of current admin (id(100,200,300,400) on testnet).
 *               Ask Seeker.
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set.
 *
 * WARNING: This is irreversible if you lose the new admin seed.
 */

import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import {
  PROCEDURE_IDS,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  encodeTransferAdminInput,
  buildProcedureTx,
  broadcastTx,
  fetchCurrentTick,
  logSection,
} from "./utils.js";

const helper = new QubicHelper();

async function main() {
  const newAdminPublicId = process.argv[2];
  const currentAdminSeed = process.argv[3] ?? process.env.QUBIC_ADMIN_SEED;

  if (!newAdminPublicId) {
    throw new Error(
      "Usage: node scripts/qubic/transfer-admin.js <newAdminPublicId> [currentAdminSeed]"
    );
  }
  if (!currentAdminSeed) {
    throw new Error(
      "Current admin seed is required.\n" +
        "  => Ask Seeker for the admin key (blocker B1)."
    );
  }

  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("transfer-admin", "Inputs");
  process.stdout.write(
    JSON.stringify({ newAdminPublicId, tick, rpcUrl: QUBIC_RPC_URL }, null, 2) +
      "\n"
  );
  process.stdout.write(
    "\nWARNING: This permanently changes the admin. Make sure you have the new admin seed.\n"
  );

  const inputBytes = encodeTransferAdminInput({ newAdmin: newAdminPublicId });

  const { signedBytes, publicId } = await buildProcedureTx(
    helper,
    currentAdminSeed,
    PROCEDURE_IDS.TransferAdmin,
    inputBytes,
    tick
  );

  logSection("transfer-admin", "Broadcasting");
  process.stdout.write(`  from: ${publicId}\n  newAdmin: ${newAdminPublicId}\n`);

  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("\nVerify with: node scripts/qubic/get-config.js\n");
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
