import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  addressOrIdToBytes,
  bytesToHex,
  hexToBytes,
  nonceToBytes,
  nonceBytesToDecimal,
  decodeSecretKey,
  normalizeSignatureValue,
  parseU32,
  parseU64,
  assertFixedBytes,
  toSafeBigInt,
  toSafeNumber,
  toU64BigInt,
} from "../../../../src/plugins/app/common/solana/bytes.js";

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

  it("converts decimal strings to u64 bigint", () => {
    assert.strictEqual(toU64BigInt("0", "amount"), 0n);
    assert.strictEqual(toU64BigInt("42", "amount"), 42n);
    assert.throws(() => toU64BigInt("1.2", "amount"), /integer string/);
    assert.throws(() => toU64BigInt("-1", "amount"), /integer string/);
    assert.throws(
      () => toU64BigInt("18446744073709551616", "amount"),
      /exceeds uint64/
    );
  });

  describe("addressOrIdToBytes", () => {
    it("converts 64-char hex address to 32 bytes", () => {
      const hex = "aa".repeat(32);
      const result = addressOrIdToBytes(hex);
      assert.strictEqual(result.length, 32);
      assert.deepStrictEqual(result, new Uint8Array(32).fill(0xaa));
    });

    it("converts 0x-prefixed hex address to 32 bytes", () => {
      const hex = "0x" + "bb".repeat(32);
      const result = addressOrIdToBytes(hex);
      assert.strictEqual(result.length, 32);
      assert.deepStrictEqual(result, new Uint8Array(32).fill(0xbb));
    });

    it("converts a 60-char Qubic ID to 32 bytes", () => {
      const qubicId = "A".repeat(60);
      const result = addressOrIdToBytes(qubicId);
      assert.strictEqual(result.length, 32);
    });

    it("converts a 48-char Qubic ID to 32 bytes", () => {
      const qubicId = "A".repeat(48);
      const result = addressOrIdToBytes(qubicId);
      assert.strictEqual(result.length, 32);
    });

    it("converts a 52-char Qubic ID to 32 bytes", () => {
      const qubicId = "B".repeat(52);
      const result = addressOrIdToBytes(qubicId);
      assert.strictEqual(result.length, 32);
    });

    it("converts a 56-char Qubic ID to 32 bytes", () => {
      const qubicId = "C".repeat(56);
      const result = addressOrIdToBytes(qubicId);
      assert.strictEqual(result.length, 32);
    });

    it("falls through to Solana base58 for invalid Qubic-looking input", () => {
      // 11111111111111111111111111111111 is the Solana system program (all 1s in base58 = 32 zero bytes)
      const result = addressOrIdToBytes("11111111111111111111111111111111");
      assert.strictEqual(result.length, 32);
    });

    it("throws for base58 that does not decode to 32 bytes", () => {
      assert.throws(() => addressOrIdToBytes("!!!"), /error/i);
    });

    it("trims whitespace from input", () => {
      const hex = "  " + "cc".repeat(32) + "  ";
      const result = addressOrIdToBytes(hex);
      assert.deepStrictEqual(result, new Uint8Array(32).fill(0xcc));
    });
  });

  describe("nonceToBytes", () => {
    it("converts 0x-prefixed hex nonce to 32 left-padded bytes", () => {
      const result = nonceToBytes("0xff");
      assert.strictEqual(result.length, 32);
      assert.strictEqual(result[31], 0xff);
      assert.strictEqual(result[0], 0);
    });

    it("converts hex nonce without 0x prefix", () => {
      const result = nonceToBytes("00ff");
      assert.strictEqual(result.length, 32);
      assert.strictEqual(result[31], 0xff);
      assert.strictEqual(result[30], 0);
    });

    it("returns exact 32 bytes when hex is already full length", () => {
      const hex = "ab".repeat(32);
      const result = nonceToBytes(hex);
      assert.strictEqual(result.length, 32);
      assert.deepStrictEqual(result, new Uint8Array(Buffer.from(hex, "hex")));
    });

    it("rejects odd-length hex nonce", () => {
      assert.throws(() => nonceToBytes("0xabc"), /byte aligned/);
    });

    it("rejects non-hex input", () => {
      assert.throws(() => nonceToBytes("not-a-nonce"), /hex string/);
    });

    it("rejects empty nonce", () => {
      assert.throws(() => nonceToBytes(""), /hex string/);
    });

    it("throws when nonce exceeds 32 bytes", () => {
      const longHex = "aa".repeat(33);
      assert.throws(() => nonceToBytes(longHex), /at most 32 bytes/);
    });
  });

  describe("nonceBytesToDecimal", () => {
    it("converts 32-byte nonce to decimal string", () => {
      const nonce = new Uint8Array(32);
      nonce[31] = 1;
      assert.strictEqual(nonceBytesToDecimal(nonce), "1");
    });

    it("converts zero nonce to '0'", () => {
      assert.strictEqual(nonceBytesToDecimal(new Uint8Array(32)), "0");
    });

    it("rejects nonce with wrong byte length", () => {
      assert.throws(() => nonceBytesToDecimal(new Uint8Array(16)), /32 bytes/);
    });

    it("round-trips with nonceToBytes for hex nonces", () => {
      const original = "00".repeat(28) + "075bcd15";
      const bytes = nonceToBytes(original);
      const hex = bytesToHex(bytes);
      assert.strictEqual(hex, original);
    });
  });

  describe("decodeSecretKey", () => {
    it("decodes a valid 64-byte base64 secret key", () => {
      const key = Buffer.alloc(64, 0x42);
      const encoded = key.toString("base64");
      const result = decodeSecretKey(encoded);
      assert.strictEqual(result.length, 64);
      assert.deepStrictEqual(result, new Uint8Array(key));
    });

    it("trims whitespace before decoding", () => {
      const key = Buffer.alloc(64, 0x01);
      const encoded = `  ${key.toString("base64")}  `;
      const result = decodeSecretKey(encoded);
      assert.strictEqual(result.length, 64);
    });

    it("rejects keys that are not 64 bytes", () => {
      const short = Buffer.alloc(32).toString("base64");
      assert.throws(() => decodeSecretKey(short), /64 bytes/);
    });
  });

  describe("normalizeSignatureValue", () => {
    it("returns string values as-is", () => {
      assert.strictEqual(normalizeSignatureValue("abc"), "abc");
    });

    it("converts Buffer to base64", () => {
      const buf = Buffer.from([1, 2, 3]);
      assert.strictEqual(normalizeSignatureValue(buf), buf.toString("base64"));
    });

    it("converts Uint8Array to base64", () => {
      const arr = new Uint8Array([4, 5, 6]);
      assert.strictEqual(
        normalizeSignatureValue(arr),
        Buffer.from(arr).toString("base64")
      );
    });

    it("throws for unsupported types", () => {
      assert.throws(() => normalizeSignatureValue(123), /unsupported/);
    });
  });

  describe("parseU32", () => {
    it("parses a valid number", () => {
      assert.strictEqual(parseU32(42, "field"), 42);
    });

    it("parses a valid string", () => {
      assert.strictEqual(parseU32("100", "field"), 100);
    });

    it("rejects negative values", () => {
      assert.throws(() => parseU32(-1, "field"), /uint32/);
    });

    it("rejects values exceeding uint32 max", () => {
      assert.throws(() => parseU32(0x100000000, "field"), /uint32/);
    });

    it("rejects non-integer values", () => {
      assert.throws(() => parseU32(1.5, "field"), /uint32/);
    });
  });

  describe("parseU64", () => {
    it("parses a bigint value", () => {
      assert.strictEqual(parseU64(100n, "field"), 100n);
    });

    it("parses a string value", () => {
      assert.strictEqual(parseU64("999", "field"), 999n);
    });

    it("parses a number value", () => {
      assert.strictEqual(parseU64(50, "field"), 50n);
    });

    it("rejects negative bigint", () => {
      assert.throws(() => parseU64(-1n, "field"), /uint64/);
    });

    it("rejects values exceeding uint64", () => {
      assert.throws(() => parseU64((1n << 64n), "field"), /uint64/);
    });
  });

  describe("assertFixedBytes", () => {
    it("passes when length matches", () => {
      assert.doesNotThrow(() => assertFixedBytes(new Uint8Array(32), "field", 32));
    });

    it("throws when length does not match", () => {
      assert.throws(() => assertFixedBytes(new Uint8Array(16), "field", 32), /32 bytes/);
    });
  });
});
