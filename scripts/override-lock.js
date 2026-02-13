
const DEFAULT_URL = "http://127.0.0.1:3015";
const baseUrl = process.env.FAKE_QUBIC_URL ?? DEFAULT_URL;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const body = {
    to: args.to ?? "",
    relayerFee: args.relayerFee ?? "0",
    nonce: args.nonce,
  };

  const res = await fetch(`${baseUrl}/override-lock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("override-lock failed", payload);
    process.exit(1);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error("override-lock failed", err);
  process.exit(1);
});
