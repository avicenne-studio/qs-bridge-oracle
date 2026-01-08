import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { buildCanonicalString } from "../../src/plugins/app/hub/hub-verifier.js";

const hubKeysFixturePath = path.join(
  process.cwd(),
  "test/fixtures/hub-keys.private.json"
);

type HubPrivateKeysFile = {
  primary: {
    current: { kid: string; privateKeyPem: string };
    next: { kid: string; privateKeyPem: string };
  };
  fallback: {
    current: { kid: string; privateKeyPem: string };
    next: { kid: string; privateKeyPem: string };
  };
};

let cachedHubKeys: HubPrivateKeysFile | null = null;

async function loadHubPrivateKeys() {
  if (cachedHubKeys) {
    return cachedHubKeys;
  }
  const raw = await fs.readFile(hubKeysFixturePath, "utf-8");
  cachedHubKeys = JSON.parse(raw) as HubPrivateKeysFile;
  return cachedHubKeys;
}

function hashBody(body?: string | Buffer | Uint8Array): string {
  if (!body) {
    return createHash("sha256").update("").digest("hex");
  }

  const payload = Buffer.from(body);

  return createHash("sha256").update(payload).digest("hex");
}

export async function signHubHeaders(input: {
  method: string;
  url: string;
  hubId?: "primary" | "fallback";
  kid?: string;
  body?: string | Buffer | Uint8Array;
  timestamp?: string;
  nonce?: string;
}) {
  const hubId = input.hubId ?? "primary";
  const keys = await loadHubPrivateKeys();
  const hubKeys = keys[hubId];
  let activeKey = hubKeys.current;
  if (input.kid) {
    if (hubKeys.current.kid === input.kid) {
      activeKey = hubKeys.current;
    } else if (hubKeys.next.kid === input.kid) {
      activeKey = hubKeys.next;
    }
  }

  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = input.nonce ?? randomBytes(16).toString("base64");
  const bodyHash = hashBody(input.body);
  const canonical = buildCanonicalString({
    method: input.method,
    url: input.url,
    hubId,
    timestamp,
    nonce,
    bodyHash,
  });

  const key = createPrivateKey(activeKey.privateKeyPem);
  const signature = sign(null, Buffer.from(canonical), key).toString("base64");

  return {
    "X-Hub-Id": hubId,
    "X-Key-Id": activeKey.kid,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Body-Hash": bodyHash,
    "X-Signature": signature,
  };
}
