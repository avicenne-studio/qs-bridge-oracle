import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import process from "node:process";

const ROOT_DIR = resolve(import.meta.dirname, "..");
const tmpRoot = join(os.tmpdir(), "oracle-sim");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

const baseEnv = {
  NODE_ENV: "production",
  FASTIFY_CLOSE_GRACE_DELAY: "1000",
  LOG_LEVEL: "info",
  RATE_LIMIT_MAX: 100,
  SOLANA_KEYS: "./test/fixtures/signer/solana.keys.json",
  QUBIC_KEYS: "./test/fixtures/signer/qubic.keys.json",
};

const oracles = [
  { id: "oracle-1", port: 3001, up: true },
  { id: "oracle-2", port: 3002, up: false },
  { id: "oracle-3", port: 3003, up: true },
  { id: "oracle-4", port: 3004, up: true },
  { id: "oracle-5", port: 3005, up: false },
];

const children = [];

function startOracle(oracle) {
  const dbFile = join(tmpRoot, `${oracle.id}.sqlite3`);
  const child = spawn("npm", ["run", "simulated"], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...baseEnv,
      PORT: String(oracle.port),
      SQLITE_DB_FILE: dbFile,
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
