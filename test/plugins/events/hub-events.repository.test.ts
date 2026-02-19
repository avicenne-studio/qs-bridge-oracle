import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../helpers/build.js";
import {
  kHubEventsRepository,
  kHubEventCursorsRepository,
  type HubEventsRepository,
  type HubEventCursorsRepository,
} from "../../../src/plugins/app/events/hub-events.repository.js";
import { hex32 } from "../../../src/plugins/app/common/bytes.js";

describe("hub events repository", () => {
  it("creates events, ignores duplicates, and finds latest cursor", async (t) => {
    const app = await build(t);
    const repo = app.getDecorator<HubEventsRepository>(kHubEventsRepository);

    const created = await repo.upsert({
      hubUrl: "http://hub-1",
      signature: "sig-1",
      slot: 1,
      chain: "solana",
      type: "outbound",
      nonce: hex32(1),
      payload: {
        networkIn: 1,
        networkOut: 2,
        tokenIn: hex32(2),
        tokenOut: hex32(3),
        fromAddress: hex32(4),
        toAddress: hex32(5),
        amount: "10",
        relayerFee: "2",
        nonce: hex32(1),
      },
      createdAt: "2024-01-01 00:00:00",
    });
    assert.ok(created);

    const duplicate = await repo.upsert({
      hubUrl: "http://hub-1",
      signature: "sig-1",
      slot: 2,
      chain: "solana",
      type: "outbound",
      nonce: hex32(1),
      payload: {
        networkIn: 1,
        networkOut: 2,
        tokenIn: hex32(2),
        tokenOut: hex32(3),
        fromAddress: hex32(4),
        toAddress: hex32(5),
        amount: "10",
        relayerFee: "2",
        nonce: hex32(1),
      },
      createdAt: "2024-01-01 00:00:01",
    });
    assert.ok(duplicate);
    assert.strictEqual(duplicate?.id, created?.id);

    await repo.upsert({
      hubUrl: "http://hub-1",
      signature: "sig-2",
      slot: 3,
      chain: "solana",
      type: "override-outbound",
      nonce: hex32(2),
      payload: {
        toAddress: hex32(6),
        relayerFee: "3",
        nonce: hex32(2),
      },
      createdAt: "2024-01-01 00:00:02",
    });

    const latest = await repo.findLatestCursor("http://hub-1");
    assert.ok(latest);
    assert.strictEqual(latest?.lastCreatedAt, "2024-01-01 00:00:02");
    assert.ok((latest?.lastId ?? 0) > 0);
  });

  it("stores and updates hub cursors", async (t) => {
    const app = await build(t);
    const cursors = app.getDecorator<HubEventCursorsRepository>(
      kHubEventCursorsRepository
    );

    const empty = await cursors.get("http://hub-2");
    assert.strictEqual(empty, null);

    await cursors.upsert({
      hubUrl: "http://hub-2",
      lastCreatedAt: "2024-01-01 00:00:00",
      lastId: 1,
    });

    const first = await cursors.get("http://hub-2");
    assert.ok(first);
    assert.strictEqual(first?.lastId, 1);

    await cursors.upsert({
      hubUrl: "http://hub-2",
      lastCreatedAt: "2024-01-01 00:00:10",
      lastId: 2,
    });

    const second = await cursors.get("http://hub-2");
    assert.ok(second);
    assert.strictEqual(second?.lastCreatedAt, "2024-01-01 00:00:10");
    assert.strictEqual(second?.lastId, 2);
  });
});
