/**
 * Smoke tests for qubic/utils.js encoding helpers.
 * Run: node --test scripts/qubic/utils.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import {
  QSB_CONTRACT_INDEX,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SOLANA_NETWORK_ID,
  QUBIC_NETWORK_ID,
  contractAddressBytes,
  encodeLockInput,
  encodeOrderStruct,
  encodeQsbOrderMessage,
  computeQsbOrderHashOffchain,
  signQsbOrder,
  encodeUnlockInput,
} from "./utils.js";

test("contractAddressBytes: 32 bytes, index 27 (explicit) at bytes [0..3] LE", () => {
  const addr = contractAddressBytes(27);
  assert.equal(addr.length, 32);
  assert.equal(addr[0], 27);
  for (let i = 1; i < 32; i++) assert.equal(addr[i], 0);
});

test("contractAddressBytes: default is QSB_CONTRACT_INDEX", () => {
  const a = contractAddressBytes();
  const b = contractAddressBytes(QSB_CONTRACT_INDEX);
  assert.deepEqual(a, b);
});

test("contractAddressBytes: multi-byte index encodes LE", () => {
  const addr = contractAddressBytes(0x0102);
  assert.equal(addr[0], 0x02);
  assert.equal(addr[1], 0x01);
  assert.equal(addr[2], 0x00);
});

// ── encodeLockInput ────────────────────────────────────────────────────────

test("encodeLockInput: exactly 88 bytes (Lock_input struct size)", () => {
  const bytes = encodeLockInput(1000, 10, "8axvTLqKVh7yqFr63Eo5g6ERzBbnGYEU2t4PKcGyYXSu", SOLANA_NETWORK_ID, 42);
  assert.equal(bytes.length, 88);
});

test("encodeLockInput: amount at [0..7] LE", () => {
  const bytes = encodeLockInput(0x0102030405060708n, 0, "", 0, 0);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigUint64(0, true), 0x0102030405060708n);
});

test("encodeLockInput: relayerFee at [8..15] LE", () => {
  const bytes = encodeLockInput(0, 999, "", 0, 0);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigUint64(8, true), 999n);
});

test("encodeLockInput: toAddress ASCII at [16..79], zero-padded", () => {
  const addr = "8axvTLq";
  const bytes = encodeLockInput(0, 0, addr, 0, 0);
  const addrBytes = bytes.slice(16, 16 + addr.length);
  assert.equal(new TextDecoder().decode(addrBytes), addr);
  assert.equal(bytes[16 + addr.length], 0);
});

test("encodeLockInput: networkOut at [80..83] LE", () => {
  const bytes = encodeLockInput(0, 0, "", SOLANA_NETWORK_ID, 0);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(80, true), SOLANA_NETWORK_ID);
});

test("encodeLockInput: nonce at [84..87] LE", () => {
  const bytes = encodeLockInput(0, 0, "", 0, 0xdeadbeef);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(84, true), 0xdeadbeef);
});

// ── encodeOrderStruct ──────────────────────────────────────────────────────

const ORDER = {
  fromAddress: new Uint8Array(32).fill(1),
  toAddress: new Uint8Array(32).fill(2),
  tokenIn: new Uint8Array(32).fill(3),
  tokenOut: new Uint8Array(32).fill(4),
  amount: 5000n,
  relayerFee: 50n,
  networkIn: SOLANA_NETWORK_ID,
  networkOut: QUBIC_NETWORK_ID,
  nonce: new Uint8Array(32).fill(5),
  orderEra: 1,
};

test("encodeOrderStruct: exactly 188 bytes (Order struct size)", () => {
  assert.equal(encodeOrderStruct(ORDER).length, 188);
});

test("encodeOrderStruct: fromAddress at [0..31]", () => {
  const bytes = encodeOrderStruct(ORDER);
  assert.deepEqual(bytes.slice(0, 32), ORDER.fromAddress);
});

test("encodeOrderStruct: toAddress at [32..63]", () => {
  const bytes = encodeOrderStruct(ORDER);
  assert.deepEqual(bytes.slice(32, 64), ORDER.toAddress);
});

test("encodeOrderStruct: amount at [128..135] LE", () => {
  const bytes = encodeOrderStruct(ORDER);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigUint64(128, true), ORDER.amount);
});

test("encodeOrderStruct: networkIn at [144..147], networkOut at [148..151]", () => {
  const bytes = encodeOrderStruct(ORDER);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(144, true), ORDER.networkIn);
  assert.equal(view.getUint32(148, true), ORDER.networkOut);
});

test("encodeOrderStruct: orderEra at [184..187]", () => {
  const bytes = encodeOrderStruct(ORDER);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(184, true), ORDER.orderEra);
});

test("encodeOrderStruct: deterministic — two calls produce identical bytes", () => {
  assert.deepEqual(encodeOrderStruct(ORDER), encodeOrderStruct(ORDER));
});

// ── encodeQsbOrderMessage ──────────────────────────────────────────────────

const QSB_MSG = {
  protocolName: PROTOCOL_NAME,
  protocolVersion: PROTOCOL_VERSION,
  contractAddress: contractAddressBytes(),
  networkIn: SOLANA_NETWORK_ID,
  networkOut: QUBIC_NETWORK_ID,
  tokenIn: new Uint8Array(32).fill(0xa),
  tokenOut: new Uint8Array(32).fill(0xb),
  fromAddress: new Uint8Array(32).fill(0xc),
  toAddress: new Uint8Array(32).fill(0xd),
  amount: 1000n,
  relayerFee: 10n,
  nonce: new Uint8Array(32).fill(0xe),
  orderEra: 2,
};

test("encodeQsbOrderMessage: exactly 256 bytes (QSBOrderMessage sizeof with C++ alignment padding)", () => {
  assert.equal(encodeQsbOrderMessage(QSB_MSG).length, 256);
});

test("encodeQsbOrderMessage: protocolNameLen = 11 at [0..3] LE", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 11); // "QubicBridge".length
});

test("encodeQsbOrderMessage: protocolName 'QubicBridge' at [4..14], bytes [15..19] zero", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  assert.equal(new TextDecoder().decode(bytes.slice(4, 15)), "QubicBridge");
  for (let i = 15; i < 20; i++) assert.equal(bytes[i], 0);
});

test("encodeQsbOrderMessage: protocolVersionLen = 1 at [20..23]", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(20, true), 1);
});

test("encodeQsbOrderMessage: protocolVersion byte = 49 ('1') at [24]", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  assert.equal(bytes[24], 49);
});

test("encodeQsbOrderMessage: contractAddress at [25..56]", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  assert.deepEqual(bytes.slice(25, 57), QSB_MSG.contractAddress);
});

test("encodeQsbOrderMessage: networkIn at [60..63], networkOut at [64..67] (after 3-byte padding)", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(60, true), QSB_MSG.networkIn);
  assert.equal(view.getUint32(64, true), QSB_MSG.networkOut);
});

test("encodeQsbOrderMessage: amount at [200..207] LE (after 4-byte padding)", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigUint64(200, true), QSB_MSG.amount);
});

test("encodeQsbOrderMessage: orderEra at [248..251]", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(248, true), QSB_MSG.orderEra);
});

test("encodeQsbOrderMessage: deterministic — two calls produce identical bytes", () => {
  assert.deepEqual(encodeQsbOrderMessage(QSB_MSG), encodeQsbOrderMessage(QSB_MSG));
});

// ── computeQsbOrderHashOffchain ────────────────────────────────────────────

test("computeQsbOrderHashOffchain: returns 32-byte Uint8Array", async () => {
  const hash = await computeQsbOrderHashOffchain(ORDER);
  assert.ok(hash instanceof Uint8Array);
  assert.equal(hash.length, 32);
});

test("computeQsbOrderHashOffchain: deterministic — two calls produce identical hash", async () => {
  const h1 = await computeQsbOrderHashOffchain(ORDER);
  const h2 = await computeQsbOrderHashOffchain(ORDER);
  assert.deepEqual(h1, h2);
});

test("computeQsbOrderHashOffchain: different order produces different hash", async () => {
  const other = { ...ORDER, amount: ORDER.amount + 1n };
  const h1 = await computeQsbOrderHashOffchain(ORDER);
  const h2 = await computeQsbOrderHashOffchain(other);
  assert.notDeepEqual(h1, h2);
});

// ── signQsbOrder ──────────────────────────────────────────────────────────

const TEST_SEED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("signQsbOrder: returns signerPublicKey (32 bytes) and signature (64 bytes)", async () => {
  const result = await signQsbOrder(ORDER, TEST_SEED);
  assert.ok(result.signerPublicKey instanceof Uint8Array);
  assert.equal(result.signerPublicKey.length, 32);
  assert.ok(result.signature instanceof Uint8Array);
  assert.equal(result.signature.length, 64);
});

test("signQsbOrder: deterministic — same key + order produce identical signature", async () => {
  const r1 = await signQsbOrder(ORDER, TEST_SEED);
  const r2 = await signQsbOrder(ORDER, TEST_SEED);
  assert.deepEqual(r1.signerPublicKey, r2.signerPublicKey);
  assert.deepEqual(r1.signature, r2.signature);
});

test("signQsbOrder: different order produces different signature", async () => {
  const other = { ...ORDER, amount: ORDER.amount + 1n };
  const r1 = await signQsbOrder(ORDER, TEST_SEED);
  const r2 = await signQsbOrder(other, TEST_SEED);
  assert.notDeepEqual(r1.signature, r2.signature);
});

test("signQsbOrder: different key produces different signerPublicKey", async () => {
  const SEED2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const r1 = await signQsbOrder(ORDER, TEST_SEED);
  const r2 = await signQsbOrder(ORDER, SEED2);
  assert.notDeepEqual(r1.signerPublicKey, r2.signerPublicKey);
});

// ── encodeUnlockInput ──────────────────────────────────────────────────────

test("encodeUnlockInput: size = 200 + n*96 (192 Order + 4 numSigs + 4 pad + n*96)", async () => {
  const sig = await signQsbOrder(ORDER, TEST_SEED);
  const one = encodeUnlockInput(ORDER, [sig]);
  assert.equal(one.length, 200 + 1 * 96);
  const three = encodeUnlockInput(ORDER, [sig, sig, sig]);
  assert.equal(three.length, 200 + 3 * 96);
});

test("encodeUnlockInput: Order bytes at [0..187] match encodeOrderStruct", async () => {
  const sig = await signQsbOrder(ORDER, TEST_SEED);
  const buf = encodeUnlockInput(ORDER, [sig]);
  assert.deepEqual(buf.slice(0, 188), encodeOrderStruct(ORDER));
});

test("encodeUnlockInput: numSignatures uint32 LE at [192..195]", async () => {
  const sig = await signQsbOrder(ORDER, TEST_SEED);
  const buf = encodeUnlockInput(ORDER, [sig, sig]);
  const view = new DataView(buf.buffer);
  assert.equal(view.getUint32(192, true), 2);
});

test("encodeUnlockInput: signerPublicKey at [200..231] for first sig", async () => {
  const sig = await signQsbOrder(ORDER, TEST_SEED);
  const buf = encodeUnlockInput(ORDER, [sig]);
  assert.deepEqual(buf.slice(200, 232), sig.signerPublicKey);
});

test("encodeUnlockInput: signature bytes at [232..295] for first sig", async () => {
  const sig = await signQsbOrder(ORDER, TEST_SEED);
  const buf = encodeUnlockInput(ORDER, [sig]);
  assert.deepEqual(buf.slice(232, 296), sig.signature);
});
