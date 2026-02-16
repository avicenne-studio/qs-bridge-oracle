import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  getAddressEncoder,
  getProgramDerivedAddress,
  prependTransactionMessageInstructions,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_WS_URL = "wss://api.devnet.solana.com";
export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
export const RENT_SYSVAR_ADDRESS = "SysvarRent111111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111";
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
export const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 0n;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;

export function resolveRpcUrl() {
  return process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
}

export function resolveWsUrl() {
  return process.env.SOLANA_WS_URL || DEFAULT_WS_URL;
}

export function createRpcClients(rpcUrl = resolveRpcUrl(), wsUrl = resolveWsUrl()) {
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  return { rpc, rpcSubscriptions, sendAndConfirmTransaction };
}

function parseUnsignedInteger(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string integer`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return value;
}

function encodeU32LE(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value, true);
  return new Uint8Array(buffer);
}

function encodeU64LE(value) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, value, true);
  return new Uint8Array(buffer);
}

function createComputeBudgetInstruction(discriminator, payload) {
  const data = new Uint8Array(1 + payload.length);
  data[0] = discriminator;
  data.set(payload, 1);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data,
  };
}

export function resolveComputeUnitLimit() {
  const raw = process.env.SOLANA_COMPUTE_UNIT_LIMIT;
  if (raw === undefined) {
    return DEFAULT_COMPUTE_UNIT_LIMIT;
  }
  const parsed = Number(parseUnsignedInteger(raw, "SOLANA_COMPUTE_UNIT_LIMIT"));
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > UINT32_MAX) {
    throw new Error("SOLANA_COMPUTE_UNIT_LIMIT must fit in uint32");
  }
  return parsed;
}

export function resolveComputeUnitPrice() {
  const raw = process.env.SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  if (raw === undefined) {
    return DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  }
  const parsed = BigInt(
    parseUnsignedInteger(raw, "SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS")
  );
  if (parsed < 0n || parsed > UINT64_MAX) {
    throw new Error(
      "SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS must fit in uint64"
    );
  }
  return parsed;
}

export function applyComputeBudget(
  message,
  {
    computeUnitLimit = resolveComputeUnitLimit(),
    computeUnitPriceMicroLamports = resolveComputeUnitPrice(),
  } = {}
) {
  const limitInstruction = createComputeBudgetInstruction(
    2,
    encodeU32LE(computeUnitLimit)
  );
  const priceInstruction = createComputeBudgetInstruction(
    3,
    encodeU64LE(computeUnitPriceMicroLamports)
  );
  return prependTransactionMessageInstructions(
    [limitInstruction, priceInstruction],
    message
  );
}

export async function readJson(filePath) {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

export async function readKeypairBytes(filePath, label = "Keypair") {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`${label} must be a JSON array of 64 bytes`);
  }
  return new Uint8Array(parsed);
}

export function parseKeypairBytes(value, label = "Keypair") {
  if (!Array.isArray(value) || value.length !== 64) {
    throw new Error(`${label} must be a JSON array of 64 bytes`);
  }
  return new Uint8Array(value);
}

export function parseHexBytes32(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a hex string`);
  }
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length !== 64 || !HEX_PATTERN.test(normalized)) {
    throw new Error(`${field} must be 32-byte hex (0x...)`);
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

function toCamelCase(input) {
  return input.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

export function parseArgs(argv, options = {}) {
  const { startIndex = 0 } = options;
  const args = { _: [] };
  for (let i = startIndex; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    const rawKey =
      eqIndex >= 0 ? withoutPrefix.slice(0, eqIndex) : withoutPrefix;
    const key = toCamelCase(rawKey);

    if (eqIndex >= 0) {
      args[key] = withoutPrefix.slice(eqIndex + 1);
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

export function logSection(prefix, title) {
  process.stdout.write(`\n[${prefix}] ${title}\n`);
}

export async function findAssociatedTokenAddress(
  owner,
  mint,
  tokenProgram = TOKEN_PROGRAM_ADDRESS,
  associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ADDRESS
) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: associatedTokenProgram,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(tokenProgram),
      getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}
