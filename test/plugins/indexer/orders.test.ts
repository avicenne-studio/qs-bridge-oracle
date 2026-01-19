import { describe, it } from "node:test";
import assert from "node:assert";

import {
  OracleOrder,
  assertValidOracleOrder,
  orderFromQubic,
  orderFromSolana,
  normalizeBridgeInstruction,
} from "../../../src/plugins/app/indexer/schemas/order.js";
import { QubicTransaction } from "../../../src/plugins/app/indexer/schemas/qubic-transaction.js";
import { SolanaTransaction } from "../../../src/plugins/app/indexer/schemas/solana-transaction.js";

const mockQubicTx: QubicTransaction = {
  sender: "AliceQ",
  recipient: "BobQ",
  amount: 999,
  nonce: 1,
};

const mockSolanaTx: SolanaTransaction = {
  recentBlockhash: "ABC123",
  feePayer: "FEEPAYER111",
  instructions: [
    {
      programId: "PROGRAM1",
      accounts: [],
      data: "encoded-bridge-data",
    },
  ],
};

describe("OracleOrder utilities", () => {
  it("should accept valid orders with different source and dest", () => {
    const order: OracleOrder = {
      id: "00000000-0000-4000-8000-000000000101",
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 10,
      relayerFee: 0,
      signature: "SOLANA_SIGNATURE_EXAMPLE",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
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
      amount: 1,
      relayerFee: 0,
      signature: "QUBIC_SIGNATURE_EXAMPLE",
      status: "ready-for-relay",
      oracle_accept_to_relay: true,
    };

    assert.throws(
      () => assertValidOracleOrder(order),
      /source and dest must differ/
    );
  });

  it("should construct an order from a Qubic transaction", () => {
    const order = orderFromQubic(
      "00000000-0000-4000-8000-000000000201",
      mockQubicTx,
      "solana",
      "QUBIC_SIGNATURE_1"
    );

    assert.strictEqual(order.id, "00000000-0000-4000-8000-000000000201");
    assert.strictEqual(order.source, "qubic");
    assert.strictEqual(order.dest, "solana");
    assert.strictEqual(order.from, mockQubicTx.sender);
    assert.strictEqual(order.to, mockQubicTx.recipient);
    assert.strictEqual(order.amount, mockQubicTx.amount);
    assert.strictEqual(order.relayerFee, 0);
    assert.strictEqual(order.signature, "QUBIC_SIGNATURE_1");
    assert.strictEqual(order.status, "ready-for-relay");
    assert.strictEqual(order.oracle_accept_to_relay, true);
  });

  it("should throw when Qubic order has identical source and dest", () => {
    assert.throws(
      () =>
        orderFromQubic(
          "00000000-0000-4000-8000-000000000202",
          mockQubicTx,
          "qubic",
          "SIG"
        ),
      /source and dest must differ/
    );
  });

  it("should throw because normalizeBridgeInstruction is not implemented", () => {
    assert.throws(
      () =>
        orderFromSolana(
          "00000000-0000-4000-8000-000000000203",
          mockSolanaTx,
          "qubic",
          "SIG"
        ),
      /not implemented/
    );
  });

  it("normalizeBridgeInstruction should always throw", () => {
    assert.throws(
      () => normalizeBridgeInstruction("foo"),
      /not implemented/
    );
  });
});
