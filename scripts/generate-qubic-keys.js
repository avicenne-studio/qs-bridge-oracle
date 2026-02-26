import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";

const SEED_LENGTH = 55;
const SEED_CHARS = "abcdefghijklmnopqrstuvwxyz";

const randomSeed = () => Array.from({ length: SEED_LENGTH }, () => SEED_CHARS[randomInt(SEED_CHARS.length)]).join("");

const seed = randomSeed();
const helper = new QubicHelper();
const id = await helper.createIdPackage(seed);

if (process.env.OUT) {
  writeFileSync(process.env.OUT, JSON.stringify({ seed }, null, 2));
}

const qubicKeys = {
  pKey: id.publicId,
  sKey: seed,
};
process.stdout.write(`${JSON.stringify(qubicKeys, null, 2)}\n`);
