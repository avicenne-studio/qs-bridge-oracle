/**
 * QSB GetConfig — reads current contract configuration.
 *
 * Usage:
 *   node scripts/qubic/get-config.js
 *
 * Env:
 *   QUBIC_RPC_URL  Bob Node (default: http://localhost:40420)
 */

import {
  QSB_CONTRACT_INDEX,
  resolveBobUrl,
  queryContractFunction,
  decodeGetConfigOutput,
  bytesToQubicId,
  FUNC_GET_CONFIG,
} from "./utils.js";

const bobUrl = resolveBobUrl();

console.log(`\n=== QSB GetConfig ===`);
console.log(`  Bob Node : ${bobUrl}`);
console.log(`  Contract : ${QSB_CONTRACT_INDEX}`);

const buf = await queryContractFunction(bobUrl, QSB_CONTRACT_INDEX, FUNC_GET_CONFIG, new Uint8Array(0));
const cfg = decodeGetConfigOutput(buf);

const adminId = await bytesToQubicId(cfg.admin);
const protocolFeeId = await bytesToQubicId(cfg.protocolFeeRecipient);
const oracleFeeId = await bytesToQubicId(cfg.oracleFeeRecipient);

console.log(`\n  admin                : ${adminId}`);
console.log(`  protocolFeeRecipient : ${protocolFeeId}`);
console.log(`  oracleFeeRecipient   : ${oracleFeeId}`);
console.log(`  bpsFee               : ${cfg.bpsFee}`);
console.log(`  protocolFee          : ${cfg.protocolFee}`);
console.log(`  oracleCount          : ${cfg.oracleCount}`);
console.log(`  pauserCount          : ${cfg.pauserCount}`);
console.log(`  oracleThreshold      : ${cfg.oracleThreshold}%`);
console.log(`  paused               : ${cfg.paused}`);
console.log(`  orderEra             : ${cfg.orderEra}`);

console.log(
  "\n" +
    JSON.stringify(
      {
        admin: adminId,
        protocolFeeRecipient: protocolFeeId,
        oracleFeeRecipient: oracleFeeId,
        bpsFee: cfg.bpsFee,
        protocolFee: cfg.protocolFee,
        oracleCount: cfg.oracleCount,
        pauserCount: cfg.pauserCount,
        oracleThreshold: cfg.oracleThreshold,
        paused: cfg.paused,
        orderEra: cfg.orderEra,
      },
      null,
      2,
    ),
);
