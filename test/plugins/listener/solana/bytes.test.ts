import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToHex,
  hexToBytes,
  toSafeBigInt,
  toSafeNumber,
} from "../../../../src/plugins/app/listener/solana/bytes.js";

describe("solana listener bytes helpers", () => {
  it("round-trips hex and bytes", () => {
    const bytes = new Uint8Array([0, 15, 255]);
    const hex = bytesToHex(bytes);
    assert.strictEqual(hex, "000fff");
    assert.deepStrictEqual(hexToBytes(hex), bytes);
    assert.deepStrictEqual(hexToBytes("0x0a"), new Uint8Array([10]));
  });

  it("validates hex input", () => {
    assert.throws(() => hexToBytes("abc"), /byte aligned/);
    assert.throws(() => hexToBytes("zz"), /non-hex/);
  });

  it("converts bigint to safe number", () => {
    assert.strictEqual(toSafeNumber(10n, "amount"), 10);
    assert.throws(() => toSafeNumber(-1n, "amount"), /exceeds max safe/);
    assert.throws(
      () => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "amount"),
      /exceeds max safe/
    );
  });

  it("converts number to safe bigint", () => {
    assert.strictEqual(toSafeBigInt(42, "amount"), 42n);
    assert.throws(() => toSafeBigInt(1.2, "amount"), /must be an integer/);
    assert.throws(() => toSafeBigInt(-1, "amount"), /exceeds max safe/);
    assert.throws(
      () => toSafeBigInt(Number.MAX_SAFE_INTEGER + 1, "amount"),
      /exceeds max safe/
    );
  });

});
