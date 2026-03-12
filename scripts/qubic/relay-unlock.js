

import { readFile } from "node:fs/promises";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import {
  PROCEDURE_IDS,
  TICK_OFFSET,
  QUBIC_RPC_URL,
  QUBIC_BOB_URL,
  CONTRACT_INDEX,
  CONTRACT_ADDRESS,
  encodeUnlockInput,
  encodeOrder,
  buildProcedureTx,
  broadcastTx,
  signWithK12,
  fetchCurrentTick,
  qubicIdToBytes,
  logSection,
} from "./utils.js";

const helper = new QubicHelper();
const DRY_RUN = process.env.DRY_RUN === "1";

// ─────────────────────────────────────────────────────────────────────────────
// KEY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function readRelayerKey(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf-8"));
  if (typeof raw === "string") return raw;
  const seed = raw.sKey ?? raw.seed;
  if (!seed) throw new Error(`relayer-key.json: missing "sKey" or "seed" field`);
  return seed;
}

async function readOracleKeys(filePath) {
  const raw = JSON.parse(await readFile(filePath, "utf-8"));
  if (!Array.isArray(raw)) throw new Error(`oracle-keys.json must be a JSON array`);
  return raw.map((entry, i) => {
    if (typeof entry === "string") {
      return { seed: entry, publicId: null };
    }
    const seed = entry.sKey ?? entry.seed;
    if (!seed) throw new Error(`oracle-keys entry ${i}: missing "sKey" or "seed"`);
    return { seed, publicId: entry.pKey ?? null };
  });
}

async function addressTo32Bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== "string") {
    throw new Error(`Address must be a string or Buffer, got ${typeof value}`);
  }

  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }

  // Try Solana base58 → 32 bytes
  try {
    const { getAddressEncoder, address } = await import("@solana/kit");
    const encoded = getAddressEncoder().encode(address(value));
    if (encoded.length === 32) {
      return Buffer.from(encoded);
    }
  } catch {
    // fall through
  }

  // Fallback: treat as Qubic public ID
  return qubicIdToBytes(value);
}

function bytesToHex(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

async function signOrderWithK12(orderBytes, seed) {
  return signWithK12(orderBytes, seed);
}

async function main() {
  const orderPath = process.argv[2];
  const oracleKeysPath = process.argv[3];
  const relayerKeyPath = process.argv[4];

  if (!orderPath || !oracleKeysPath || !relayerKeyPath) {
    throw new Error(
      "Usage: node scripts/qubic/relay-unlock.js <order.json> <oracle-keys.json> <relayer-key.json>\n" +
      "\n" +
      "Example:\n" +
      "  node scripts/qubic/relay-unlock.js \\\n" +
      "    .temp/qubic-order.json \\\n" +
      "    .temp/oracle-qubic-keys.json \\\n" +
      "    .temp/qubic-admin.json"
    );
  }

  logSection("relay-unlock", "Configuration");
  process.stdout.write(
    JSON.stringify(
      {
        rpcUrl: QUBIC_RPC_URL,
        bobUrl: QUBIC_BOB_URL,
        contractIndex: CONTRACT_INDEX,
        contractAddress: CONTRACT_ADDRESS,
        dryRun: DRY_RUN,
      },
      null,
      2
    ) + "\n"
  );

  // ── Load inputs ────────────────────────────────────────────────────────────

  const orderRaw = JSON.parse(await readFile(orderPath, "utf-8"));
  const oracleEntries = await readOracleKeys(oracleKeysPath);
  const relayerSeed = await readRelayerKey(relayerKeyPath);

  const order = {
    fromAddress: await addressTo32Bytes(orderRaw.fromAddress),
    toAddress: await addressTo32Bytes(orderRaw.toAddress),
    tokenIn: BigInt(orderRaw.tokenIn ?? "0"),
    tokenOut: BigInt(orderRaw.tokenOut ?? "0"),
    amount: BigInt(orderRaw.amount),
    relayerFee: BigInt(orderRaw.relayerFee),
    destinationChainId: Number(orderRaw.destinationChainId ?? orderRaw.networkOut),
    networkIn: Number(orderRaw.networkIn ?? 0),
    networkOut: Number(orderRaw.networkOut),
    nonce: Number(orderRaw.nonce),
  };

  // Resolve relayer public ID
  const relayerIdentity = await helper.createIdPackage(relayerSeed);

  logSection("relay-unlock", "Order");
  process.stdout.write(
    JSON.stringify(
      {
        ...order,
        fromAddress: bytesToHex(order.fromAddress),
        toAddress: bytesToHex(order.toAddress),
        amount: order.amount.toString(),
        relayerFee: order.relayerFee.toString(),
        tokenIn: order.tokenIn.toString(),
        tokenOut: order.tokenOut.toString(),
      },
      null,
      2
    ) + "\n"
  );

  logSection("relay-unlock", `Relayer: ${relayerIdentity.publicId}`);

  // ── Resolve oracle public IDs ──────────────────────────────────────────────

  logSection("relay-unlock", `Resolving ${oracleEntries.length} oracle public ID(s)`);
  const oracles = [];
  for (const entry of oracleEntries) {
    if (entry.publicId) {
      oracles.push(entry);
      process.stdout.write(`  ${entry.publicId} (from file)\n`);
    } else {
      const id = await helper.createIdPackage(entry.seed);
      oracles.push({ seed: entry.seed, publicId: id.publicId });
      process.stdout.write(`  ${id.publicId} (derived)\n`);
    }
  }

  // ── Sign order with each oracle ────────────────────────────────────────────

  const orderBytes = encodeOrder(order);

  logSection("relay-unlock", `Signing with ${oracles.length} oracle(s)`);
  const signatures = [];
  for (const oracle of oracles) {
    const sig = await signOrderWithK12(orderBytes, oracle.seed);
    signatures.push(sig);
  }

  // ── Encode Unlock input ────────────────────────────────────────────────────

  const inputBytes = encodeUnlockInput({ order, signatures });

  logSection("relay-unlock", `Encoded UnlockInput: ${inputBytes.length} bytes`);
  process.stdout.write(`  (expected ~6276 bytes: 128 order + 4 numSigs + 64×96 sigs)\n`);

  // ── Fetch tick and build tx ────────────────────────────────────────────────

  const currentTick = await fetchCurrentTick();
  const tick = currentTick + TICK_OFFSET;

  logSection("relay-unlock", `Tick: ${currentTick} → targeting ${tick}`);

  const { signedBytes, publicId } = await buildProcedureTx(
    helper,
    relayerSeed,
    PROCEDURE_IDS.Unlock,
    inputBytes,
    tick
    // no invocationReward for Unlock (relayer fee comes from locked amount on-chain)
  );

  logSection("relay-unlock", "Signed transaction ready");
  process.stdout.write(
    `  relayer : ${publicId}\n` +
    `  tick    : ${tick}\n` +
    `  tx size : ${signedBytes.length} bytes\n`
  );

  // ── Dry-run or broadcast ───────────────────────────────────────────────────

  if (DRY_RUN) {
    logSection("relay-unlock", "DRY RUN — skipping broadcast");
    process.stdout.write("  Set DRY_RUN=0 (or omit) to broadcast.\n");
    return;
  }

  logSection("relay-unlock", "Broadcasting...");
  const result = await broadcastTx(signedBytes);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  logSection("relay-unlock", "Done");
  process.stdout.write(
    "\nVerify the Unlock event:\n" +
    "  node scripts/qubic/poll-events.js --limit 5\n" +
    `  node scripts/qubic/verify-event.js --hash <txHash> --type unlock\n` +
    "\nVerify replay protection:\n" +
    `  node scripts/qubic/is-order-filled.js --hash <orderHash>\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
