import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import process from "node:process";
import { DEFAULT_RPC_URL } from "./utils.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");
const tmpRoot = join(os.tmpdir(), "oracle-sim");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

const hubKeysFile = join(tmpRoot, "hub-keys.json");
const hubKeys = {
  primary: {
    current: {
      kid: "current-1",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAWRWu5e67npLDHhLZRVeePKmuBCz7aGnflyVclzIXra0=\n-----END PUBLIC KEY-----\n",
    },
    next: {
      kid: "next-1",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAWRWu5e67npLDHhLZRVeePKmuBCz7aGnflyVclzIXra0=\n-----END PUBLIC KEY-----\n",
    },
  },
  fallback: {
    current: {
      kid: "current-1",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAWRWu5e67npLDHhLZRVeePKmuBCz7aGnflyVclzIXra0=\n-----END PUBLIC KEY-----\n",
    },
    next: {
      kid: "next-1",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAWRWu5e67npLDHhLZRVeePKmuBCz7aGnflyVclzIXra0=\n-----END PUBLIC KEY-----\n",
    },
  },
};
writeFileSync(hubKeysFile, JSON.stringify(hubKeys, null, 2));

const baseEnv = {
  NODE_ENV: "production",
  FASTIFY_CLOSE_GRACE_DELAY: "1000",
  LOG_LEVEL: "info",
  RATE_LIMIT_MAX: 100,
  HOST: "127.0.0.1",
  SOLANA_RPC_URL: DEFAULT_RPC_URL,
  SOLANA_TX_COMMITMENT: "confirmed",
  SOLANA_TX_RETRY_MAX_ATTEMPTS: "6",
  SOLANA_TX_RETRY_BASE_MS: "500",
  SOLANA_TX_RETRY_MAX_MS: "4000",
  RELAYER_FEE_PERCENT: "0.1",
  SOLANA_KEYS: "./test/fixtures/signer/solana.keys.json",
  QUBIC_KEYS: "./test/fixtures/signer/qubic.keys.json",
  HUB_URLS: "http://127.0.0.1:3010,http://127.0.0.1:3011",
  HUB_KEYS_FILE: hubKeysFile,
};

const oracles = [
  { id: "oracle-1", port: 3001, up: true },
  { id: "oracle-2", port: 3002, up: true },
  { id: "oracle-3", port: 3003, up: true },
  { id: "oracle-4", port: 3004, up: true },
  { id: "oracle-5", port: 3005, up: true },
];

const children = [];

function startOracle(oracle) {
  const dbFile = join(tmpRoot, `${oracle.id}.sqlite3`);
  const solanaKeysFile = `./test/fixtures/signer/solana-${oracle.id.split("-")[1]}.keys.json`;
  const child = spawn("npm", ["run", "simulated"], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...baseEnv,
      PORT: String(oracle.port),
      SQLITE_DB_FILE: dbFile,
      SOLANA_KEYS: solanaKeysFile,
    },
  });

  const prefix = `[${oracle.id}:${oracle.port}] `;
  child.stdout.on("data", (chunk) =>
    process.stdout.write(prefix + chunk.toString())
  );
  child.stderr.on("data", (chunk) =>
    process.stderr.write(prefix + chunk.toString())
  );

  children.push(child);
}

for (const oracle of oracles) {
  if (oracle.up) {
    startOracle(oracle);
  } else {
    process.stderr.write(`[${oracle.id}:${oracle.port}] intentionally down\n`);
  }
}

function shutdown() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  // eslint-disable-next-line no-undef
  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(0);
  }, 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
