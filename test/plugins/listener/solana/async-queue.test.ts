import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncQueue } from "../../../../src/plugins/app/listener/solana/async-queue.js";

describe("async queue", () => {
  it("runs tasks sequentially", async () => {
    const queue = new AsyncQueue();
    const order: number[] = [];

    queue.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    });
    queue.push(async () => {
      throw new Error("boom");
    });
    queue.push(async () => {
      order.push(2);
    });
    await queue.push(async () => {
      order.push(3);
    });

    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it("logs when tasks fail", async () => {
    const errors: unknown[] = [];
    const queue = new AsyncQueue((error) => {
      errors.push(error);
    });

    await queue.push(async () => {
      throw new Error("boom");
    });

    assert.strictEqual(errors.length, 1);
    assert.strictEqual((errors[0] as Error).message, "boom");
  });
});
