import { it, describe } from "node:test";
import assert from "node:assert";
import { build } from "../../helper.js";

describe("ordersRepository", () => {
  it("should create and retrieve an order by id", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 101,
      source: "solana",
      dest: "qubic",
      from: "Alice",
      to: "Bob",
      amount: 123,
      signature: "sig-solana-1",
      status: "ready-for-relay",
      is_relayable: true,
    });

    assert.ok(created);
    assert.strictEqual(created?.id, 101);
    assert.strictEqual(created?.source, "solana");
    assert.strictEqual(created?.dest, "qubic");
    assert.strictEqual(created?.from, "Alice");
    assert.strictEqual(created?.to, "Bob");
    assert.strictEqual(created?.amount, 123);
    assert.strictEqual(created?.signature, "sig-solana-1");
    assert.strictEqual(created?.status, "ready-for-relay");
    assert.strictEqual(created?.is_relayable, true);

    const fetched = await repo.findById(created!.id);
    assert.deepStrictEqual(fetched, created);
  });

  it("should return orders by ids", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    // Insert 3 orders
    const order1 = await repo.create({
      id: 201,
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 10,
      signature: "sig-a",
      status: "ready-for-relay",
      is_relayable: true,
    });
    const order2 = await repo.create({
      id: 202,
      source: "solana",
      dest: "qubic",
      from: "C",
      to: "D",
      amount: 20,
      signature: "sig-b",
      status: "ready-for-relay",
      is_relayable: true,
    });
    await repo.create({
      id: 203,
      source: "qubic",
      dest: "solana",
      from: "E",
      to: "F",
      amount: 30,
      signature: "sig-c",
      status: "ready-for-relay",
      is_relayable: true,
    });

    const fetched = await repo.byIds([order2!.id, order1!.id, order2!.id]);
    assert.strictEqual(fetched.length, 2);
    assert.strictEqual(fetched[0].id, order1!.id);
    assert.strictEqual(fetched[1].id, order2!.id);
    assert.strictEqual(fetched.length, 2);
  });

  it("should return empty list when byIds is empty", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const fetched = await repo.byIds([]);
    assert.deepStrictEqual(fetched, []);
  });

  it("should reject byIds when exceeding the limit", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await assert.rejects(() => repo.byIds(ids), /Cannot request more than 100/);
  });

  it("should return pending orders ordered and limited", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    for (let i = 1; i <= 55; i += 1) {
      await repo.create({
        id: i,
        source: "solana",
        dest: "qubic",
        from: `A-${i}`,
        to: `B-${i}`,
        amount: i,
        signature: `sig-${i}`,
        status: "ready-for-relay",
        is_relayable: true,
      });
    }

    await repo.create({
      id: 1001,
      source: "qubic",
      dest: "solana",
      from: "SkipA",
      to: "SkipB",
      amount: 1,
      signature: "sig-skip",
      status: "ready-for-relay",
      is_relayable: false,
    });

    const pending = await repo.findPendingOrders();
    assert.strictEqual(pending.length, 50);
    assert.strictEqual(pending[0].id, 1);
    assert.strictEqual(pending[49].id, 50);
  });

  it("should update an order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 301,
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 50,
      signature: "sig-update",
      status: "ready-for-relay",
      is_relayable: true,
    });

    const updated = await repo.update(created!.id, { amount: 42 });

    assert.ok(updated);
    assert.strictEqual(updated?.amount, 42);

    const fetched = await repo.findById(created!.id);
    assert.strictEqual(fetched?.amount, 42);
  });

  it("should return null when updating a non-existent order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const updated = await repo.update(9999, { amount: 100 });
    assert.strictEqual(updated, null);
  });

  it("should delete an order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 401,
      source: "solana",
      dest: "qubic",
      from: "DeleteA",
      to: "DeleteB",
      amount: 7,
      signature: "sig-delete",
      status: "ready-for-relay",
      is_relayable: true,
    });

    const removed = await repo.delete(created!.id);
    assert.strictEqual(removed, true);

    const after = await repo.findById(created!.id);
    assert.strictEqual(after, null);
  });

  it("should return false when deleting a non-existent order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const removed = await repo.delete(9999);
    assert.strictEqual(removed, false);
  });

  it("should add unique signatures to an order", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 501,
      source: "solana",
      dest: "qubic",
      from: "SigA",
      to: "SigB",
      amount: 5,
      signature: "sig-main",
      status: "ready-for-relay",
      is_relayable: true,
    });

    const inserted = await repo.addSignatures(created!.id, [
      "sig-1",
      "sig-2",
      "sig-1",
    ]);
    assert.deepStrictEqual(inserted.sort(), ["sig-1", "sig-2"]);

    const insertedAgain = await repo.addSignatures(created!.id, ["sig-2"]);
    assert.deepStrictEqual(insertedAgain, []);
  });

  it("should return empty list when adding no signatures", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const created = await repo.create({
      id: 601,
      source: "solana",
      dest: "qubic",
      from: "EmptySigA",
      to: "EmptySigB",
      amount: 9,
      signature: "sig-empty",
      status: "ready-for-relay",
      is_relayable: true,
    });

    const inserted = await repo.addSignatures(created!.id, []);
    assert.deepStrictEqual(inserted, []);
  });

  it("should return relayable orders with signatures", async (t) => {
    const app = await build(t);
    const repo = app.ordersRepository;

    const relayable = await repo.create({
      id: 701,
      source: "solana",
      dest: "qubic",
      from: "RelayA",
      to: "RelayB",
      amount: 11,
      signature: "sig-relay",
      status: "ready-for-relay",
      is_relayable: true,
    });

    const notRelayable = await repo.create({
      id: 702,
      source: "qubic",
      dest: "solana",
      from: "SkipA",
      to: "SkipB",
      amount: 12,
      signature: "sig-skip",
      status: "ready-for-relay",
      is_relayable: false,
    });

    await repo.addSignatures(relayable!.id, ["sig-a", "sig-b"]);
    await repo.addSignatures(notRelayable!.id, ["sig-c"]);

    const results = await repo.findRelayableOrders();
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, relayable!.id);
    assert.deepStrictEqual(results[0].signatures.sort(), ["sig-a", "sig-b"]);
  });
});
