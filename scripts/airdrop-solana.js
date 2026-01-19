import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import process from "node:process";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
} from "@solana/kit";

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_LAMPORTS = 1_000_000_000n;
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 1000;

async function readKeypairBytes(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("Keypair file must be a JSON array of 64 bytes");
  }
  return new Uint8Array(parsed);
}

async function resolveAddress(arg) {
  try {
    const info = await stat(arg);
    if (info.isFile()) {
      const keyBytes = await readKeypairBytes(arg);
      const signer = await createKeyPairSignerFromBytes(keyBytes);
      return signer.address;
    }
  } catch {
    // Not a file path, treat as address.
  }
  return address(arg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const target = process.argv[2];
  const amountRaw = process.argv[3];
  if (!target) {
    throw new Error(
      "Usage: node scripts/airdrop-solana.js <address|keypair.json> [lamports]"
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const lamports = amountRaw ? BigInt(amountRaw) : DEFAULT_LAMPORTS;
  if (lamports <= 0n) {
    throw new Error("Lamports must be greater than 0");
  }

  const targetAddress = await resolveAddress(target);
  const rpc = createSolanaRpc(rpcUrl);
  let signature;
  let lastError;
  for (let attempt = 1; attempt <= DEFAULT_RETRIES; attempt += 1) {
    try {
      const response = await rpc.requestAirdrop(targetAddress, lamports).send();
      signature =
        response?.value ??
        response?.result ??
        response?.signature ??
        response;
      break;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable =
        message.includes("429") || message.includes("Too Many Requests");
      if (!retryable || attempt === DEFAULT_RETRIES) {
        throw error;
      }
      const delayMs = DEFAULT_RETRY_DELAY_MS * attempt;
      process.stderr.write(
        `Airdrop failed (${message}). Retrying in ${delayMs}ms...\n`
      );
      await sleep(delayMs);
    }
  }
  if (!signature) {
    throw lastError || new Error("Airdrop failed");
  }

  process.stdout.write(
    `Airdrop requested: ${lamports.toString()} lamports\n` +
      `Address: ${targetAddress}\n` +
      `Signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
