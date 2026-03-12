/**
 * verify-event.js
 * Fetch a specific transaction from the Bob Node by hash and verify
 * that the emitted log matches an expected event payload.
 *
 * Usage:
 *   node scripts/qubic/verify-event.js --hash <txHash> [--type <lock|unlock|cancel>]
 *
 * Options:
 *   --hash    Transaction hash (hex string) to look up
 *   --type    Expected event type for validation hint (optional)
 *
 * [BLOCKED: S3] Bob Node GET /tx/{hash} response format is unconfirmed.
 *               Ask Seeker for exact shape of the receipt and log fields.
 */

import { Buffer } from "node:buffer";
import process from "node:process";
import {
  QUBIC_BOB_URL,
  CONTRACT_INDEX,
  getTxByHash,
  logSection,
  parseArgs,
} from "./utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// DECODERS
// [BLOCKED: S3] All field names and byte layouts are assumptions until Seeker
// confirms the actual Bob Node receipt and event payload format.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to decode a Lock event payload.
 * [BLOCKED: S1] Layout assumption:
 *   sender(32) | amount(8) | relayerFee(8) | networkOut(4) |
 *   nonce(4) | toAddress(64) | orderHash(32)
 * Total: ~152 bytes
 */
function decodeLockEvent(buf) {
  if (buf.length < 1) return { raw: buf.toString("hex"), note: "Empty buffer" };
  if (buf.length < 152) {
    return {
      raw: buf.toString("hex"),
      note: `[BLOCKED S1] Buffer too short (${buf.length} bytes, expected ~152)`,
    };
  }
  let offset = 0;
  const sender = buf.slice(offset, offset + 32).toString("hex"); offset += 32;
  const amount = buf.readBigUInt64LE(offset).toString(); offset += 8;
  const relayerFee = buf.readBigUInt64LE(offset).toString(); offset += 8;
  const networkOut = buf.readUInt32LE(offset); offset += 4;
  const nonce = buf.readUInt32LE(offset); offset += 4;
  const toAddress = buf.slice(offset, offset + 64).toString("hex"); offset += 64;
  const orderHash = buf.slice(offset, offset + 32).toString("hex");
  return { sender, amount, relayerFee, networkOut, nonce, toAddress, orderHash };
}

/**
 * Attempt to decode an Unlock event payload.
 * [BLOCKED: S1] Layout TBC — may include relayer + order hash only.
 */
function decodeUnlockEvent(buf) {
  if (buf.length < 64) {
    return {
      raw: buf.toString("hex"),
      note: `[BLOCKED S1] Buffer too short for Unlock event (${buf.length} bytes)`,
    };
  }
  let offset = 0;
  const relayer = buf.slice(offset, offset + 32).toString("hex"); offset += 32;
  const orderHash = buf.slice(offset, offset + 32).toString("hex");
  return { relayer, orderHash };
}

/**
 * Attempt to decode a CancelLock event payload.
 * [BLOCKED: S1] Layout TBC — likely just sender + nonce.
 */
function decodeCancelEvent(buf) {
  if (buf.length < 36) {
    return {
      raw: buf.toString("hex"),
      note: `[BLOCKED S1] Buffer too short for CancelLock event (${buf.length} bytes)`,
    };
  }
  let offset = 0;
  const sender = buf.slice(offset, offset + 32).toString("hex"); offset += 32;
  const nonce = buf.readUInt32LE(offset);
  return { sender, nonce };
}

const DECODERS = {
  lock: decodeLockEvent,
  unlock: decodeUnlockEvent,
  cancel: decodeCancelEvent,
};

async function main() {
  const args = parseArgs(process.argv, { startIndex: 2 });
  const txHash = args.hash;
  const eventType = args.type ?? null;

  if (!txHash) {
    throw new Error(
      "Usage: node scripts/qubic/verify-event.js --hash <txHash> [--type lock|unlock|cancel]"
    );
  }

  logSection("verify-event", `Bob Node: ${QUBIC_BOB_URL}, hash=${txHash}`);

  // [BLOCKED: S3] getTxByHash calls GET /tx/{hash} or equivalent on Bob Node.
  // Adjust the endpoint in utils.js once Seeker confirms the Bob API.
  const receipt = await getTxByHash(txHash);

  logSection("verify-event", "Raw receipt");
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");

  if (!receipt) {
    process.stdout.write("Transaction not found.\n");
    return;
  }

  // [BLOCKED: S3] Try to extract logs from the receipt.
  // These field names are guesses — adjust once confirmed.
  const logs =
    receipt.logs ??
    receipt.events ??
    receipt.logEntries ??
    (receipt.log ? [receipt.log] : null);

  if (!logs || logs.length === 0) {
    process.stdout.write(
      "[BLOCKED S3] No 'logs' / 'events' field found in receipt. Check Bob Node format with Seeker.\n"
    );
    return;
  }

  logSection("verify-event", `Found ${logs.length} log(s)`);

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    process.stdout.write(`\n--- Log ${i + 1} ---\n`);
    process.stdout.write(JSON.stringify(log, null, 2) + "\n");

    // [BLOCKED: S3] Try to decode the data payload if present
    const rawData =
      log.data ?? log.payload ?? log.eventData ?? null;

    if (rawData && typeof rawData === "string") {
      let buf;
      // Try base64 first, then hex
      try {
        buf = Buffer.from(rawData, "base64");
        if (buf.toString("base64") !== rawData) {
          buf = Buffer.from(rawData, "hex");
        }
      } catch {
        process.stdout.write("Could not decode data field as base64 or hex.\n");
        continue;
      }

      process.stdout.write(`Data (${buf.length} bytes): ${buf.toString("hex")}\n`);

      // Decode based on requested type or try all
      const decoder = eventType ? DECODERS[eventType.toLowerCase()] : null;
      if (decoder) {
        process.stdout.write(`\nDecoded as ${eventType}:\n`);
        process.stdout.write(JSON.stringify(decoder(buf), null, 2) + "\n");
      } else {
        process.stdout.write("\nAttempting decode as each event type:\n");
        for (const [typeName, decodeFn] of Object.entries(DECODERS)) {
          process.stdout.write(`  [${typeName}]: `);
          try {
            process.stdout.write(JSON.stringify(decodeFn(buf)) + "\n");
          } catch (e) {
            process.stdout.write(`error: ${e.message}\n`);
          }
        }
      }
    }
  }

  // Summary
  logSection("verify-event", "Summary");
  process.stdout.write(
    [
      `  tx hash  : ${txHash}`,
      `  logs     : ${logs.length}`,
      `  contract : index ${CONTRACT_INDEX}`,
      `  note     : [BLOCKED S3] Verify field names above with Seeker before trusting decoded output`,
    ].join("\n") + "\n"
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
