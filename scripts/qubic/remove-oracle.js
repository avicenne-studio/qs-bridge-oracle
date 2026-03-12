/**
 * remove-oracle.js
 * Remove an oracle from the contract via RemoveRole (procedure 13, role=1).
 *
 * Usage:
 *   node scripts/qubic/remove-oracle.js <oraclePublicId> [adminSeed]
 *   QUBIC_ADMIN_SEED=<seed> node scripts/qubic/remove-oracle.js <oraclePublicId>
 *
 * [BLOCKED: B1] Requires admin seed.
 * [BLOCKED: S1] RemoveRoleInput byte layout must be confirmed by Seeker.
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set.
 */

import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import {
  PROCEDURE_IDS,
  ROLE,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  encodeRoleInput,
  buildProcedureTx,
  broadcastTx,
  fetchCurrentTick,
  logSection,
} from "./utils.js";

const helper = new QubicHelper();

async function main() {
  const oraclePublicId = process.argv[2];
  const adminSeed = process.argv[3] ?? process.env.QUBIC_ADMIN_SEED;

  if (!oraclePublicId) {
    throw new Error(
      "Usage: node scripts/qubic/remove-oracle.js <oraclePublicId> [adminSeed]"
    );
  }
  if (!adminSeed) {
    throw new Error(
      "Admin seed is required. Set QUBIC_ADMIN_SEED or pass as second argument.\n" +
        "  => Ask Seeker for the admin key (blocker B1)."
    );
  }

  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("remove-oracle", "Inputs");
  process.stdout.write(
    JSON.stringify({ oraclePublicId, tick, rpcUrl: QUBIC_RPC_URL }, null, 2) +
      "\n"
  );

  const inputBytes = encodeRoleInput({
    account: oraclePublicId,
    role: ROLE.Oracle,
  });

  const { signedBytes, publicId } = await buildProcedureTx(
    helper,
    adminSeed,
    PROCEDURE_IDS.RemoveRole,
    inputBytes,
    tick
  );

  logSection("remove-oracle", "Broadcasting");
  process.stdout.write(`  from: ${publicId}\n  oracle: ${oraclePublicId}\n`);

  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("\nVerify with: node scripts/qubic/get-oracles.js\n");
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
