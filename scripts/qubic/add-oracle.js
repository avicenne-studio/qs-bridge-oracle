/**
 * add-oracle.js
 * Register an oracle on the Qubic contract via AddRole (procedure 12, role=1).
 * Must be called from the admin account.
 *
 * Usage:
 *   node scripts/qubic/add-oracle.js <oraclePublicId> [adminSeed]
 *
 *   # Or with env vars:
 *   QUBIC_ADMIN_SEED=<seed> node scripts/qubic/add-oracle.js <oraclePublicId>
 *
 * [BLOCKED: B1] Requires admin seed for contract index 24.
 *               Ask Seeker for the seed of id(100,200,300,400) or the new admin.
 * [BLOCKED: S1] AddRoleInput byte layout must be confirmed by Seeker.
 * [BLOCKED: S7] CONTRACT_ADDRESS must be set (contract index 24 identity).
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
      "Usage: node scripts/qubic/add-oracle.js <oraclePublicId> [adminSeed]\n" +
        "  Or set QUBIC_ADMIN_SEED env var."
    );
  }
  if (!adminSeed) {
    throw new Error(
      // [BLOCKED: B1]
      "Admin seed is required. Set QUBIC_ADMIN_SEED or pass as second argument.\n" +
        "  => Ask Seeker for the admin key (blocker B1)."
    );
  }

  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("add-oracle", "Inputs");
  process.stdout.write(
    JSON.stringify(
      { oraclePublicId, role: "Oracle (1)", tick, rpcUrl: QUBIC_RPC_URL },
      null,
      2
    ) + "\n"
  );

  const inputBytes = encodeRoleInput({
    account: oraclePublicId,
    role: ROLE.Oracle,
  });

  const { signedBytes, publicId } = await buildProcedureTx(
    helper,
    adminSeed,
    PROCEDURE_IDS.AddRole,
    inputBytes,
    tick
    // no invocation reward for admin procedures
  );

  logSection("add-oracle", "Broadcasting");
  process.stdout.write(`  from: ${publicId}\n`);
  process.stdout.write(`  to oracle: ${oraclePublicId}\n`);
  process.stdout.write(`  tick: ${tick}\n`);

  const result = await broadcastTx(signedBytes);
  process.stdout.write("\nBroadcast result:\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  process.stdout.write(
    "\nVerify with:\n" +
      `  node scripts/qubic/get-oracles.js\n` +
      `  node scripts/qubic/get-config.js\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
