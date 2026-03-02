import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { kKnex, type KnexAccessor } from "../../infra/@knex.js";

import { OracleOrder } from "./schemas/order.js";

export const ORDERS_TABLE_NAME = "orders";
export const ORDER_SIGNATURES_TABLE_NAME = "order_signatures";
export const kOrdersRepository = Symbol("app.ordersRepository");
export type OrdersRepository = ReturnType<typeof createRepository>;

type PersistedOrder = OracleOrder;
type PersistedSignature = {
  id: string;
  order_id: string;
  signature: string;
};
type StoredOrder = OracleOrder;
type CreateOrder = OracleOrder;
type UpdateOrder = Partial<Omit<OracleOrder, "destination_trx_hash" | "failure_reason_public" | "next_relay_at" | "last_relay_error">> & {
  destination_trx_hash?: string | null;
  failure_reason_public?: string | null;
  next_relay_at?: string | null;
  last_relay_error?: string | null;
};
type StoredOrderWithSignatures = StoredOrder & { signatures: string[] };

const MAX_BY_IDS = 100;
const MAX_CONSENSUS = 50;
const MAX_READY_FOR_RELAY = 50;

function normalizeOrderRow(row: StoredOrder): StoredOrder {
  return {
    ...row,
    oracle_accept_to_relay: Boolean(row.oracle_accept_to_relay),
    relay_attempts: Number(row.relay_attempts),
    failure_reason_public: row.failure_reason_public ?? undefined,
    next_relay_at: row.next_relay_at ?? undefined,
    last_relay_error: row.last_relay_error ?? undefined,
  };
}

function createRepository(fastify: FastifyInstance) {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async findById(id: string) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .where("id", id)
        .first();
      return row ? normalizeOrderRow(row as StoredOrder) : null;
    },

    async create(newOrder: CreateOrder) {
      await knex<PersistedOrder>(ORDERS_TABLE_NAME).insert(newOrder);
      return this.findById(newOrder.id);
    },

    async update(id: string, changes: UpdateOrder) {
      const payload = { ...changes } as Record<string, unknown>;
      if (payload.status !== "failed") {
        payload.failure_reason_public = null;
      }
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .update(payload);

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async markReadyForRelay(id: string) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .whereIn("status", ["pending", "ready-for-relay"])
        .update({ status: "ready-for-relay" });

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async delete(id: string) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .delete();

      return affectedRows > 0;
    },

    async byIds(ids: string[]) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) {
        return [];
      }
      if (uniqueIds.length > MAX_BY_IDS) {
        throw new Error(`Cannot request more than ${MAX_BY_IDS} orders`);
      }

      const rows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .whereIn("id", uniqueIds)
        .orderBy("id", "asc")
        .limit(MAX_BY_IDS);

      return rows.map((row) => normalizeOrderRow(row as StoredOrder));
    },

    async findConsensusOrders() {
      const rows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .whereRaw("created_at >= datetime('now', '-1 day')")
        .whereIn("status", [
          "pending",
          "ready-for-relay",
          "relayed",
          "finalized",
          "failed",
        ])
        .orderBy("id", "asc")
        .limit(MAX_CONSENSUS);

      return rows.map((row) => normalizeOrderRow(row as StoredOrder));
    },

    async findReadyForRelay(maxRelayAttempts: number, limit = MAX_READY_FOR_RELAY) {
      const rows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .where({
          status: "ready-for-relay",
        })
        .andWhere("oracle_accept_to_relay", 1)
        .andWhere("relay_attempts", "<", maxRelayAttempts)
        .andWhere((builder) => {
          builder.whereNull("next_relay_at").orWhere(
            "next_relay_at",
            "<=",
            knex.fn.now()
          );
        })
        .orderBy("id", "asc")
        .limit(limit);

      return rows.map((row) => normalizeOrderRow(row as StoredOrder));
    },

    async findSignatures(orderId: string): Promise<string[]> {
      const rows = await knex<PersistedSignature>(ORDER_SIGNATURES_TABLE_NAME)
        .select("signature")
        .where({ order_id: orderId });
      return rows.map((row) => row.signature);
    },

    async addSignatures(orderId: string, signatures: string[]) {
      const unique = [...new Set(signatures)];
      if (unique.length === 0) {
        return [];
      }

      const existing = await knex<PersistedSignature>(
        ORDER_SIGNATURES_TABLE_NAME
      )
        .select("signature")
        .where({ order_id: orderId })
        .whereIn("signature", unique);

      const existingSet = new Set(existing.map((row) => row.signature));
      const toInsert = unique.filter(
        (signature) => !existingSet.has(signature)
      );

      if (toInsert.length === 0) {
        return [];
      }

      await knex<PersistedSignature>(ORDER_SIGNATURES_TABLE_NAME).insert(
        toInsert.map((signature) => ({
          id: randomUUID(),
          order_id: orderId,
          signature,
        }))
      );

      return toInsert;
    },

    async findRelayableOrders() {
      const rows = await knex
        .from(`${ORDERS_TABLE_NAME} as orders`)
        .leftJoin(
          `${ORDER_SIGNATURES_TABLE_NAME} as signatures`,
          "orders.id",
          "signatures.order_id"
        )
        .select(
          "orders.source",
          "orders.dest",
          "orders.from",
          "orders.to",
          "orders.amount",
          "orders.relayerFee",
          "orders.origin_trx_hash",
          "orders.destination_trx_hash",
          "orders.source_payload",
          "orders.signature",
          "orders.failure_reason_public",
          "orders.status",
          "orders.oracle_accept_to_relay",
          "orders.relay_attempts",
          "orders.id",
          "signatures.signature as order_signature"
        )
        .where("orders.oracle_accept_to_relay", 1)
        .andWhere("orders.status", "ready-for-relay")
        .orderBy("orders.id", "asc");

      const orders = new Map<string, StoredOrderWithSignatures>();
      for (const row of rows as Array<
        StoredOrder & { order_signature: string | null }
      >) {
        const id = String(row.id);
        const existing = orders.get(id);
        if (!existing) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { order_signature: _orderSignature, ...order } = row;
          orders.set(id, {
            ...normalizeOrderRow(order as StoredOrder),
            signatures: [],
          });
        }
        if (row.order_signature) {
          orders.get(id)?.signatures.push(row.order_signature);
        }
      }

      return [...orders.values()];
    },

    async findBySourceNonce(sourceNonce: string) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .where("source_nonce", sourceNonce)
        .first();
      return row ? normalizeOrderRow(row as StoredOrder) : null;
    },
  };
}

export default fp(
  function (fastify) {
    fastify.decorate(kOrdersRepository, createRepository(fastify));
  },
  {
    name: "orders-repository",
    dependencies: ["knex"],
  }
);
