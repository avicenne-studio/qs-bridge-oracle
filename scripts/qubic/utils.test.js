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

test("encodeQsbOrderMessage: exactly 245 bytes (QSBOrderMessage struct size)", () => {
  assert.equal(encodeQsbOrderMessage(QSB_MSG).length, 245);
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

test("encodeQsbOrderMessage: networkIn at [57..60], networkOut at [61..64]", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(57, true), QSB_MSG.networkIn);
  assert.equal(view.getUint32(61, true), QSB_MSG.networkOut);
});

test("encodeQsbOrderMessage: amount at [193..200] LE", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getBigUint64(193, true), QSB_MSG.amount);
});

test("encodeQsbOrderMessage: orderEra at [241..244]", () => {
  const bytes = encodeQsbOrderMessage(QSB_MSG);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(241, true), QSB_MSG.orderEra);
});

test("encodeQsbOrderMessage: deterministic — two calls produce identical bytes", () => {
  assert.deepEqual(encodeQsbOrderMessage(QSB_MSG), encodeQsbOrderMessage(QSB_MSG));
});
