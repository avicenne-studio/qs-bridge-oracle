import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";

const SEED_LENGTH = 55;
const SEED_CHARS = "abcdefghijklmnopqrstuvwxyz";

function randomSeed() {
  let s = "";
  for (let i = 0; i < SEED_LENGTH; i++) {
    s += SEED_CHARS[randomInt(SEED_CHARS.length)];
  }
  return s;
}

const seed = randomSeed();
const helper = new QubicHelper();
const id = await helper.createIdPackage(seed);

const outPath = process.env.OUT;
if (outPath) {
  writeFileSync(outPath, JSON.stringify({ seed }, null, 2));
}

const qubicKeys = {
  pKey: id.publicId,
  sKey: seed,
};
process.stdout.write(`${JSON.stringify(qubicKeys, null, 2)}\n`);
