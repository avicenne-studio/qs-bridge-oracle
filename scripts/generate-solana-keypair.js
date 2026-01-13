import { writeFileSync } from "node:fs";
import { randomBytes, webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  createKeyPairFromPrivateKeyBytes,
} from "@solana/keys";
import {
  createKeyPairSignerFromBytes,
} from "@solana/kit";

const seed32 = randomBytes(32);
const keyPair = await createKeyPairFromPrivateKeyBytes(seed32);
const publicKeyBytes = new Uint8Array(
  await webcrypto.subtle.exportKey("raw", keyPair.publicKey)
);

const secretKey64 = new Uint8Array(64);
secretKey64.set(seed32, 0);
secretKey64.set(publicKeyBytes, 32);

const signer = await createKeyPairSignerFromBytes(secretKey64);

const outPath = process.env.OUT;
if (!outPath) {
  process.stderr.write("OUT is required (e.g. OUT=./test/fixtures/solana-id.json)\n");
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(Array.from(secretKey64)));

const solanaKeys = {
  pKey: signer.address,
  sKey: Buffer.from(secretKey64).toString("base64"),
};

process.stdout.write(`${JSON.stringify(solanaKeys, null, 2)}\n`);
