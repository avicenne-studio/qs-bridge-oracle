import { parseArgs } from "./utils.js";

const DEFAULT_URL = "http://127.0.0.1:3015";
const baseUrl = globalThis.process.env.FAKE_QUBIC_URL ?? DEFAULT_URL;

async function main() {
  const args = parseArgs(globalThis.process.argv, { startIndex: 2 });
  const body = {
    from: args.from ?? "",
    to: args.to ?? "",
    amount: args.amount ?? "0",
    relayerFee: args.relayerFee ?? "0",
    nonce: args.nonce,
  };

  const res = await globalThis.fetch(`${baseUrl}/lock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    globalThis.console.error("lock failed", payload);
    globalThis.process.exit(1);
  }

  globalThis.console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  globalThis.console.error("lock failed", err);
  globalThis.process.exit(1);
});
