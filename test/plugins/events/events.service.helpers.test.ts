import { test } from "node:test";
import assert from "node:assert/strict";
import { loadInitialCursor } from "../../../src/plugins/app/events/events.service.js";
import type {
  HubEventCursorsRepository,
  HubEventsRepository,
} from "../../../src/plugins/app/events/hub-events.repository.js";

test("loadInitialCursor uses existing cursor when present", async () => {
  let latestCalls = 0;
  const existing = {
    hubUrl: "http://hub",
    lastCreatedAt: "2024-01-01 00:00:00",
    lastId: 5,
  };
  const cursor = await loadInitialCursor("http://hub", {
    lookbackDays: 14,
    eventsRepository: {
      async findLatestCursor() {
        latestCalls += 1;
        return null;
      },
    } as HubEventsRepository,
    cursorsRepository: {
      async get() {
        return existing;
      },
      async upsert() {
        return;
      },
    } as HubEventCursorsRepository,
  });
  assert.deepStrictEqual(cursor, existing);
  assert.strictEqual(latestCalls, 0);
});

test("loadInitialCursor falls back to latest event when cursor is missing", async () => {
  const latest = {
    hubUrl: "http://hub",
    lastCreatedAt: "2024-01-02 00:00:00",
    lastId: 7,
  };
  let upserted: typeof latest | null = null;
  const cursor = await loadInitialCursor("http://hub", {
    lookbackDays: 14,
    eventsRepository: {
      async findLatestCursor() {
        return latest;
      },
    } as HubEventsRepository,
    cursorsRepository: {
      async get() {
        return null;
      },
      async upsert(next) {
        upserted = next;
      },
    } as HubEventCursorsRepository,
  });
  assert.deepStrictEqual(cursor, latest);
  assert.deepStrictEqual(upserted, latest);
});

test("loadInitialCursor uses lookback when no cursor or events exist", async () => {
  let upserted: { hubUrl: string; lastCreatedAt: string; lastId: number } | null =
    null;
  const cursor = await loadInitialCursor("http://hub", {
    lookbackDays: 7,
    eventsRepository: {
      async findLatestCursor() {
        return null;
      },
    } as HubEventsRepository,
    cursorsRepository: {
      async get() {
        return null;
      },
      async upsert(next) {
        upserted = next;
      },
    } as HubEventCursorsRepository,
  });
  assert.strictEqual(cursor.hubUrl, "http://hub");
  assert.strictEqual(cursor.lastId, 0);
  assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(cursor.lastCreatedAt));
  assert.deepStrictEqual(upserted, cursor);
});
