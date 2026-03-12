/**
 * generate-keys.js
 * Generate a new Qubic key pair (seed → publicId).
 *
 * Usage:
 *   node scripts/qubic/generate-keys.js
 *   OUT=./.temp/oracle-1.qubic.keys.json node scripts/qubic/generate-keys.js
 *
 * Output:
 *   { pKey: "<publicId>", sKey: "<seed>" }
 *
 * Test wallet seeds (pre-generated for QA):
 *   slmvcerjvoncdlluydvilhuddusewxgoshuhgwelljzjykfllywlhon  (user-1)
 *   jaceqhnbufbcyoninbynpmglseulbuabscdrqttdwlflirpxnhnknpz  (user-2)
 *   pyvsehwfkqwihkhynsqggnewzbuiheoqaozlxdosmvcoayaauyrqtuu  (user-3)
 *   ughdrtzbfhqhmzsnoxvalppxbgmbfazcgvocacdkfrwnolzvrzqzbny  (user-4)
 *   krmnalawaxnhqvruzumckiefwbelpbvsyivvprfmsnhyfdwgxxvjsfr  (user-5)
 *   uggcbsmkggyynepudfecjnuhmrguihspdcojltjgvkcowtrviatzajv  (user-6)
 *   gmcccpxjvdfqlanaekolzxqstbdnvxurvfzxvqrsyjjcotmdsjrkomc  (user-7)
 *   kxpsjbvgaahjzltbnqdhehzdinicvxnvvutliqifadbiyqldgayhfzy  (user-8)
 *   hluajlytdqztjtefcbzcwkrdaopvaaaruaexfcnptuolussvepekjbx  (user-9)
 *   vyvymjcxxstbzthfflpsgjvgjlbxrctmorynuelhnwkghuwxmbszdqf  (user-10)
 */

import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import process from "node:process";
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";

const SEED_LENGTH = 55;
const SEED_CHARS = "abcdefghijklmnopqrstuvwxyz";

function randomSeed() {
  return Array.from(
    { length: SEED_LENGTH },
    () => SEED_CHARS[randomInt(SEED_CHARS.length)]
  ).join("");
}

const seedArg = process.argv[2]; // optional: pass an existing seed to derive publicId
const seed = seedArg ?? randomSeed();

const helper = new QubicHelper();
const id = await helper.createIdPackage(seed);

const qubicKeys = {
  pKey: id.publicId,
  sKey: seed,
};

if (process.env.OUT) {
  writeFileSync(process.env.OUT, JSON.stringify(qubicKeys, null, 2));
  process.stdout.write(`Keys written to ${process.env.OUT}\n`);
}

process.stdout.write(`${JSON.stringify(qubicKeys, null, 2)}\n`);
