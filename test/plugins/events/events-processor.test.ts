import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { toPublicFailureReason } from "../../../src/plugins/app/events/events-processor.js";
import { mapStoredEventToSolanaPayload } from "../../../src/plugins/app/events/solana/solana-event-mapper.js";

test("mapStoredEventToSolanaPayload defaults orderEra to 0 when missing", () => {
  const hex = (v: number) => Buffer.from(new Uint8Array(32).fill(v)).toString("hex");
  const base = { id: 1, signature: "sig", chain: "solana" as const, nonce: hex(1), createdAt: new Date().toISOString() };
  const outbound = mapStoredEventToSolanaPayload({
    ...base, type: "outbound",
    payload: { networkIn: 1, networkOut: 1, tokenIn: hex(2), tokenOut: hex(3), fromAddress: hex(4), toAddress: hex(5), amount: "10", relayerFee: "2", nonce: hex(1) },
  });
  assert.strictEqual(outbound.type, "outbound");
  if (outbound.type === "outbound") { assert.strictEqual(outbound.event.orderEra, 0); }
  const inbound = mapStoredEventToSolanaPayload({
    ...base, type: "inbound",
    payload: { networkIn: 1, networkOut: 2, tokenIn: hex(2), tokenOut: hex(3), fromAddress: hex(4), toAddress: hex(5), amount: "10", relayerFee: "2", nonce: hex(1) },
  });
  assert.strictEqual(inbound.type, "inbound");
  if (inbound.type === "inbound") { assert.strictEqual(inbound.event.orderEra, 0); }
});

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
