import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { address, createTransactionMessage } from "@solana/kit";
import {
  padToLength,
  findAssociatedTokenAddress,
  applyComputeBudget,
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
} from "../../../../src/plugins/app/common/solana/program.js";

describe("program helpers", () => {
  describe("padToLength", () => {
    it("pads a shorter array with fillers", () => {
      assert.deepStrictEqual(padToLength([1, 2], 5, 0), [1, 2, 0, 0, 0]);
    });

    it("slices a longer array to the target length", () => {
      assert.deepStrictEqual(padToLength([1, 2, 3, 4, 5], 3, 0), [1, 2, 3]);
    });
  });

  describe("findAssociatedTokenAddress", () => {
    it("derives a deterministic ATA address", async () => {
      const owner = address("11111111111111111111111111111111");
      const mint = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

      const ata = await findAssociatedTokenAddress(owner, mint, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
      const ata2 = await findAssociatedTokenAddress(owner, mint, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS);

      assert.strictEqual(typeof ata, "string");
      assert.ok(ata.length > 0);
      assert.strictEqual(ata, ata2);
    });
  });

  describe("applyComputeBudget", () => {
    it("prepends two compute budget instructions", () => {
      const result = applyComputeBudget(createTransactionMessage({ version: "legacy" }));
      const instructions = (result as unknown as { instructions: readonly unknown[] }).instructions;
      assert.strictEqual(instructions.length, 2);
    });
  });
});
