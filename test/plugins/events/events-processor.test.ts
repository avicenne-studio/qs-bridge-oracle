import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicFailureReason } from "../../../src/plugins/app/events/events-processor.js";

test("toPublicFailureReason maps known errors", () => {
  assert.strictEqual(
    toPublicFailureReason(new Error("Transaction failed")),
    "Transaction failed"
  );
  assert.strictEqual(
    toPublicFailureReason(new Error("Transaction not found or not finalized yet")),
    "Transaction not found"
  );
  assert.strictEqual(
    toPublicFailureReason(new Error("Transaction events do not match hub payload")),
    "Transaction data mismatch"
  );
  assert.strictEqual(
    toPublicFailureReason(new Error("Boom")),
    "Event processing failed"
  );
  assert.strictEqual(toPublicFailureReason("boom"), "Event processing failed");
});
