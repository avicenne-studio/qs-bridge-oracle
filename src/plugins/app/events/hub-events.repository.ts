import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kKnex, type KnexAccessor } from "../../infra/@knex.js";
import { type SolanaEventPayload } from "./solana/schemas/solana-event.js";
import { type QubicEventPayload } from "./qubic/schemas/qubic-event.js";

export const HUB_EVENTS_TABLE_NAME = "hub_events";
export const HUB_EVENT_CURSORS_TABLE_NAME = "hub_event_cursors";
export const kHubEventsRepository = Symbol("app.hubEventsRepository");
export const kHubEventCursorsRepository = Symbol("app.hubEventCursorsRepository");

export type HubEventStatus = "pending" | "done" | "failed";

export type StoredHubEvent = {
  id: number;
  hubUrl: string;
  signature: string;
  slot?: number;
  chain: "solana" | "qubic";
  type: "outbound" | "override-outbound" | "inbound" | "lock" | "override-lock" | "unlock";
  nonce: string;
  payload: SolanaEventPayload | QubicEventPayload;
  createdAt: string;
  status: HubEventStatus;
  retryCount: number;
  failureCode?: string | null;
  failureReasonInternal?: string | null;
  lastFailureAt?: string | null;
  processedAt?: string | null;
};

export type NewHubEvent = Omit<
  StoredHubEvent,
  | "id"
  | "status"
  | "retryCount"
  | "failureCode"
  | "failureReasonInternal"
  | "lastFailureAt"
  | "processedAt"
  | "slot"
> & { slot: number | null };

type PersistedHubEvent = {
  id: number;
  hub_url: string;
  signature: string;
  slot: number | null;
  chain: string;
  type: string;
  nonce: string;
  payload: string;
  created_at: string;
  status: HubEventStatus;
  retry_count: number;
  failure_code: string | null;
  failure_reason_internal: string | null;
  last_failure_at: string | null;
  processed_at: string | null;
};

export type HubEventCursor = {
  hubUrl: string;
  lastCreatedAt: string;
  lastId: number;
};

type PersistedHubEventCursor = {
  hub_url: string;
  last_created_at: string;
  last_id: number;
  updated_at?: string;
};

function normalizeEvent(row: PersistedHubEvent): StoredHubEvent {
  return {
    id: row.id,
    hubUrl: row.hub_url,
    signature: row.signature,
    slot: row.slot ?? undefined,
    chain: row.chain as StoredHubEvent["chain"],
    type: row.type as StoredHubEvent["type"],
    nonce: row.nonce,
    payload: JSON.parse(row.payload) as StoredHubEvent["payload"],
    createdAt: row.created_at,
    status: row.status,
    retryCount: row.retry_count,
    failureCode: row.failure_code,
    failureReasonInternal: row.failure_reason_internal,
    lastFailureAt: row.last_failure_at,
    processedAt: row.processed_at,
  };
}

function normalizeCursor(row: PersistedHubEventCursor): HubEventCursor {
  return {
    hubUrl: row.hub_url,
    lastCreatedAt: row.last_created_at,
    lastId: row.last_id,
  };
}

function createHubEventsRepository(fastify: FastifyInstance) {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async upsert(event: NewHubEvent) {
      const payload = JSON.stringify(event.payload);
      const inserted = await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .insert({
          hub_url: event.hubUrl,
          signature: event.signature,
          slot: event.slot,
          chain: event.chain,
          type: event.type,
          nonce: event.nonce,
          payload,
          created_at: event.createdAt,
          status: "pending",
          retry_count: 0,
        })
        .onConflict(["signature", "type", "nonce"])
        .ignore();

      void inserted;
      const row = await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .select("*")
        .where({
          signature: event.signature,
          type: event.type,
          nonce: event.nonce,
        })
        .first();
      return normalizeEvent(row as PersistedHubEvent);
    },

    async listPending(limit: number) {
      const rows = await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .select("*")
        .where({ status: "pending" })
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(limit);
      return rows.map((row) => normalizeEvent(row));
    },

    async findBySignature(signature: string) {
      const row = await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .select("*")
        .where({ signature })
        .first();
      return row ? normalizeEvent(row) : null;
    },

    async markDone(id: number) {
      await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .where({ id })
        .update({
          status: "done",
          processed_at: knex.fn.now(),
          failure_code: null,
          failure_reason_internal: null,
          last_failure_at: null,
        });
    },

    async recordFailure(opts: {
      id: number;
      retryCount: number;
      status: HubEventStatus;
      failureCode: string;
      failureReasonInternal: string;
    }) {
      await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .where({ id: opts.id })
        .update({
          retry_count: opts.retryCount,
          status: opts.status,
          failure_code: opts.failureCode,
          failure_reason_internal: opts.failureReasonInternal,
          last_failure_at: knex.fn.now(),
        });
    },

    async findLatestCursor(hubUrl: string) {
      const row = await knex<PersistedHubEvent>(HUB_EVENTS_TABLE_NAME)
        .select("created_at", "id")
        .where({ hub_url: hubUrl })
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .first();
      if (!row) {
        return null;
      }
      return {
        hubUrl,
        lastCreatedAt: row.created_at,
        lastId: row.id,
      };
    },
  };
}

function createHubEventCursorsRepository(fastify: FastifyInstance) {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async get(hubUrl: string) {
      const row = await knex<PersistedHubEventCursor>(HUB_EVENT_CURSORS_TABLE_NAME)
        .select("hub_url", "last_created_at", "last_id")
        .where({ hub_url: hubUrl })
        .first();
      return row ? normalizeCursor(row) : null;
    },

    async upsert(cursor: HubEventCursor) {
      await knex<PersistedHubEventCursor>(HUB_EVENT_CURSORS_TABLE_NAME)
        .insert({
          hub_url: cursor.hubUrl,
          last_created_at: cursor.lastCreatedAt,
          last_id: cursor.lastId,
          updated_at: knex.fn.now(),
        })
        .onConflict(["hub_url"])
        .merge({
          last_created_at: cursor.lastCreatedAt,
          last_id: cursor.lastId,
          updated_at: knex.fn.now(),
        });
    },
  };
}

export type HubEventsRepository = ReturnType<typeof createHubEventsRepository>;
export type HubEventCursorsRepository = ReturnType<
  typeof createHubEventCursorsRepository
>;

export default fp(
  function hubEventsRepositoryPlugin(fastify) {
    if (!fastify.hasDecorator(kHubEventsRepository)) {
      fastify.decorate(kHubEventsRepository, createHubEventsRepository(fastify));
    }
    if (!fastify.hasDecorator(kHubEventCursorsRepository)) {
      fastify.decorate(
        kHubEventCursorsRepository,
        createHubEventCursorsRepository(fastify)
      );
    }
  },
  {
    name: "hub-events-repository",
    dependencies: ["knex"],
  }
);
