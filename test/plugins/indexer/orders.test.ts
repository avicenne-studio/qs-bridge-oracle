import { describe, it } from "node:test";
import assert from "node:assert";

import {
  OracleOrder,
  assertValidOracleOrder,
  normalizeBridgeInstruction,
} from "../../../src/plugins/app/indexer/schemas/order.js";


describe("OracleOrder utilities", () => {
  it("should accept valid orders with different source and dest", () => {
    const order: OracleOrder = {
      id: "00000000-0000-4000-8000-000000000101",
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "SOLANA_SIGNATURE_EXAMPLE",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      max_relay_attempts: 3,
      source_nonce: "nonce",
      source_payload: "payload",
    };

    assert.doesNotThrow(() => assertValidOracleOrder(order));
  });

  it("should reject orders where source === dest", () => {
    const order: OracleOrder = {
      id: "00000000-0000-4000-8000-000000000102",
      source: "qubic",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "1",
      relayerFee: "0",
      origin_trx_hash: "trx-hash",
      signature: "QUBIC_SIGNATURE_EXAMPLE",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
      relay_attempts: 0,
      max_relay_attempts: 3,
      source_nonce: "nonce",
      source_payload: "payload",
    };

    assert.throws(
      () => assertValidOracleOrder(order),
      /source and dest must differ/
    );
  });

  it("normalizeBridgeInstruction should always throw", () => {
    assert.throws(
      () => normalizeBridgeInstruction("foo"),
      /not implemented/
    );
  });
});
