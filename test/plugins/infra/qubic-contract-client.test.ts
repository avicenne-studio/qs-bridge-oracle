import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import Fastify from "fastify";

import { UndiciClient } from "../../../src/plugins/infra/undici-client.js";
import {
  createQubicContractClient,
  decodeGetLockedOrder,
  decodeGetOracles,
  decodeGetLockedOrders,
  encodeGetLockedOrderInput,
  FUNC_GET_LOCKED_ORDER,
  FUNC_GET_ORACLES,
  FUNC_GET_LOCKED_ORDERS,
} from "../../../src/plugins/infra/qubic-contract-client.js";

function buildLockedOrderEntryBuf(opts: {
  sender?: Uint8Array;
  amount?: bigint;
  relayerFee?: bigint;
  networkOut?: number;
  nonce?: number;
  toAddress?: string;
  orderHash?: Uint8Array;
  lockEpoch?: number;
  orderEra?: number;
  active?: boolean;
} = {}): Buffer {
  const buf = Buffer.alloc(168);
  buf.set(opts.sender ?? new Uint8Array(32).fill(0xaa), 0);
  buf.writeBigUInt64LE(opts.amount ?? 1000n, 32);
  buf.writeBigUInt64LE(opts.relayerFee ?? 10n, 40);
  buf.writeUInt32LE(opts.networkOut ?? 2, 48);
  buf.writeUInt32LE(opts.nonce ?? 42, 52);
  buf.write((opts.toAddress ?? "SolanaAddressHere").slice(0, 64), 56, "ascii");
  buf.set(opts.orderHash ?? new Uint8Array(32).fill(0xff), 120);
  buf.writeUInt32LE(opts.lockEpoch ?? 100, 152);
  buf.writeUInt32LE(opts.orderEra ?? 0, 156);
  buf.writeUInt8(opts.active !== false ? 1 : 0, 160);
  return buf;
}

async function startMockServer(
  t: import("node:test").TestContext,
  handler: (body: unknown) => unknown,
) {
  const server = Fastify({ logger: false });
  server.post("/querySmartContract", async (req) => handler(req.body));
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  t.after(() => server.close());
  return `http://127.0.0.1:${addr.port}`;
}

async function startGetServer(
  t: import("node:test").TestContext,
  route: string,
  handler: () => unknown,
) {
  const server = Fastify({ logger: false });
  server.get(route, async () => handler());
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address() as import("node:net").AddressInfo;
  t.after(() => server.close());
  return `http://127.0.0.1:${addr.port}`;
}

describe("decodeGetOracles", () => {
  it("returns an empty array when count is 0", () => {
    const buf = Buffer.alloc(8 + 64 * 32);
    buf.writeUInt32LE(0, 0);
    assert.strictEqual(decodeGetOracles(buf.toString("hex")).length, 0);
  });

  it("reads two keys starting at byte offset 8", () => {
    const key1 = new Uint8Array(32).fill(0x01);
    const key2 = new Uint8Array(32).fill(0x02);
    // u32 count (4B) + u32 padding (4B, id is 8-byte aligned) + key1 (32B) + key2 (32B)
    const buf = Buffer.alloc(8 + 64 * 32);
    buf.writeUInt32LE(2, 0);
    buf.set(key1, 8);
    buf.set(key2, 40);
    const keys = decodeGetOracles(buf.toString("hex"));
    assert.strictEqual(keys.length, 2);
    assert.deepStrictEqual(keys[0], key1, "first key must match bytes 8–39");
    assert.deepStrictEqual(keys[1], key2, "second key must match bytes 40–71");
  });
});

describe("decodeGetLockedOrder", () => {
  it("returns null when exists is 0", () => {
    const buf = Buffer.alloc(176);
    buf.writeUInt8(0, 0);
    assert.strictEqual(decodeGetLockedOrder(buf.toString("hex")), null);
  });

  it("decodes a present order from bytes 8–175", () => {
    const entry = buildLockedOrderEntryBuf({
      sender: new Uint8Array(32).fill(0xab),
      amount: 5000n,
      relayerFee: 50n,
      networkOut: 2,
      nonce: 7,
      toAddress: "SolAddr",
      orderHash: new Uint8Array(32).fill(0xcd),
      lockEpoch: 3,
      orderEra: 1,
      active: true,
    });
    // bit(1) + pad(7) + entry(168) = 176 bytes
    const buf = Buffer.alloc(176);
    buf.writeUInt8(1, 0);
    buf.set(entry, 8);

    const order = decodeGetLockedOrder(buf.toString("hex"));
    assert.notStrictEqual(order, null);
    assert.deepStrictEqual(order!.sender, new Uint8Array(32).fill(0xab));
    assert.strictEqual(order!.amount, 5000n);
    assert.strictEqual(order!.relayerFee, 50n);
    assert.strictEqual(order!.networkOut, 2);
    assert.strictEqual(order!.nonce, 7);
    assert.deepStrictEqual(order!.orderHash, new Uint8Array(32).fill(0xcd));
    assert.strictEqual(order!.lockEpoch, 3);
    assert.strictEqual(order!.orderEra, 1);
    assert.strictEqual(order!.active, true);
  });
});

describe("decodeGetLockedOrders", () => {
  it("decodes totalActive, returned and entries", () => {
    const entry = buildLockedOrderEntryBuf({ nonce: 99, amount: 7777n, active: true });
    const buf = Buffer.alloc(8 + 64 * 168);
    buf.writeUInt32LE(5, 0);  // totalActive
    buf.writeUInt32LE(1, 4);  // returned
    buf.set(entry, 8);

    const result = decodeGetLockedOrders(buf.toString("hex"));
    assert.strictEqual(result.totalActive, 5);
    assert.strictEqual(result.returned, 1);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].nonce, 99);
    assert.strictEqual(result.entries[0].amount, 7777n);
    assert.strictEqual(result.entries[0].active, true);
  });

  it("returns empty entries when returned is 0", () => {
    const buf = Buffer.alloc(8 + 64 * 168);
    buf.writeUInt32LE(0, 0);
    buf.writeUInt32LE(0, 4);
    const result = decodeGetLockedOrders(buf.toString("hex"));
    assert.strictEqual(result.entries.length, 0);
  });
});

describe("encodeGetLockedOrderInput", () => {
  it("encodes nonce as 4-byte LE hex", () => {
    const hex = encodeGetLockedOrderInput(42);
    const buf = Buffer.from(hex, "hex");
    assert.strictEqual(buf.length, 4);
    assert.strictEqual(buf.readUInt32LE(0), 42);
  });
});

describe("queryContractFunction", () => {
  it("returns data hex on success", async (t) => {
    const url = await startMockServer(t, () => ({ data: "deadbeef" }));
    const client = new UndiciClient();
    t.after(() => client.close());
    const result = await createQubicContractClient(client, url).queryContractFunction(FUNC_GET_ORACLES, "");
    assert.strictEqual(result, "deadbeef");
  });

  it("throws on HTTP error", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/querySmartContract", async (_req, reply) => {
      return reply.code(502).send("bad gateway");
    });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const url = `http://127.0.0.1:${(addr as import("node:net").AddressInfo).port}`;
    t.after(() => server.close());

    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.rejects(
      () => createQubicContractClient(client, url).queryContractFunction(FUNC_GET_ORACLES, ""),
      /querySmartContract HTTP 502/,
    );
  });

  it("throws after max retries when always pending", async (t) => {
    const url = await startMockServer(t, () => ({ error: "pending" }));
    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.rejects(
      () => createQubicContractClient(client, url).queryContractFunction(FUNC_GET_LOCKED_ORDER, encodeGetLockedOrderInput(1)),
      /still pending after/,
    );
  }, { timeout: 10_000 });

  it("retries and succeeds after one pending response", async (t) => {
    let calls = 0;
    const url = await startMockServer(t, () => {
      calls++;
      return calls === 1 ? { error: "pending" } : { data: "aabb" };
    });
    const client = new UndiciClient();
    t.after(() => client.close());
    const result = await createQubicContractClient(client, url).queryContractFunction(FUNC_GET_LOCKED_ORDERS, "0000000040000000");
    assert.strictEqual(result, "aabb");
    assert.strictEqual(calls, 2);
  });

  it("throws on unexpected response shape", async (t) => {
    const url = await startMockServer(t, () => ({ unexpected: true }));
    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.rejects(
      () => createQubicContractClient(client, url).queryContractFunction(FUNC_GET_ORACLES, ""),
      /unexpected response/,
    );
  });

  it("re-throws non-HTTP errors unchanged", async (t) => {
    const server = Fastify({ logger: false });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    await server.close();

    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.rejects(
      () => createQubicContractClient(client, url).queryContractFunction(FUNC_GET_ORACLES, ""),
      (err: Error) => !err.message.startsWith("querySmartContract HTTP"),
    );
  });
});

describe("getBobStatus", () => {
  it("reads epoch from currentProcessingEpoch", async (t) => {
    const url = await startGetServer(t, "/status", () => ({ currentProcessingEpoch: 42, currentFetchingTick: 100, currentIndexingTick: 99 }));
    const client = new UndiciClient();
    t.after(() => client.close());
    const result = await createQubicContractClient(client, url).getBobStatus();
    assert.strictEqual(result.epoch, 42);
    assert.strictEqual(result.tick, 100);
    assert.strictEqual(result.fetchingTick, 100);
    assert.strictEqual(result.indexingTick, 99);
  });

  it("falls back to epoch field when currentProcessingEpoch is absent", async (t) => {
    const url = await startGetServer(t, "/status", () => ({ epoch: 7, tick: 50 }));
    const client = new UndiciClient();
    t.after(() => client.close());
    const result = await createQubicContractClient(client, url).getBobStatus();
    assert.strictEqual(result.epoch, 7);
    assert.strictEqual(result.tick, 50);
    assert.strictEqual(result.fetchingTick, 50);
    assert.strictEqual(result.indexingTick, 50);
  });

  it("defaults epoch and tick to 0 when fields are absent", async (t) => {
    const url = await startGetServer(t, "/status", () => ({}));
    const client = new UndiciClient();
    t.after(() => client.close());
    const result = await createQubicContractClient(client, url).getBobStatus();
    assert.strictEqual(result.epoch, 0);
    assert.strictEqual(result.tick, 0);
    assert.strictEqual(result.fetchingTick, 0);
    assert.strictEqual(result.indexingTick, 0);
  });
});

describe("broadcastTransaction", () => {
  it("resolves on a successful broadcast", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/broadcastTransaction", async () => ({ transactionId: "abc", peersBroadcasted: 3 }));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    t.after(() => server.close());

    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.doesNotReject(() => createQubicContractClient(client, url).broadcastTransaction("deadbeef"));
  });

  it("throws with 'Qubic broadcast failed' on HTTP error", async (t) => {
    const server = Fastify({ logger: false });
    server.post("/broadcastTransaction", async (_req, reply) => reply.code(500).send("error"));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    t.after(() => server.close());

    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.rejects(
      () => createQubicContractClient(client, url).broadcastTransaction("deadbeef"),
      /Qubic broadcast failed: HTTP 500/,
    );
  });

  it("re-throws non-HTTP errors unchanged", async (t) => {
    const server = Fastify({ logger: false });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const addr = server.server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    await server.close();

    const client = new UndiciClient();
    t.after(() => client.close());
    await assert.rejects(
      () => createQubicContractClient(client, url).broadcastTransaction("deadbeef"),
      (err: Error) => !err.message.startsWith("Qubic broadcast failed"),
    );
  });
});
