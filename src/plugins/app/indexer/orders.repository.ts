import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kKnex, type KnexAccessor } from "../../infra/@knex.js";

import { OracleOrder } from "./schemas/order.js";

export const ORDERS_TABLE_NAME = "orders";
export const ORDER_SIGNATURES_TABLE_NAME = "order_signatures";
export const kOrdersRepository = Symbol("app.ordersRepository");
export type OrdersRepository = ReturnType<typeof createRepository>;

type PersistedOrder = OracleOrder;
type PersistedSignature = {
  order_id: number;
  signature: string;
};
type StoredOrder = OracleOrder;
type CreateOrder = OracleOrder;
type UpdateOrder = Partial<OracleOrder>;
type StoredOrderWithSignatures = StoredOrder & { signatures: string[] };

const MAX_BY_IDS = 100;
const MAX_PENDING = 50;

function normalizeOrderRow(row: StoredOrder): StoredOrder {
  return {
    ...row,
    oracle_accept_to_relay: Boolean(row.oracle_accept_to_relay),
  };
}

function createRepository(fastify: FastifyInstance) {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async findById(id: number) {
      const row = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .where("id", id)
        .first();
      return row ? normalizeOrderRow(row as StoredOrder) : null;
    },

    async create(newOrder: CreateOrder) {
      const [id] = await knex<PersistedOrder>(ORDERS_TABLE_NAME).insert(
        newOrder
      );
      return this.findById(Number(id));
    },

    async update(id: number, changes: UpdateOrder) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .update(changes);

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async markReadyForRelay(id: number) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .update({ status: "ready-for-relay", oracle_accept_to_relay: true });

      if (affectedRows === 0) {
        return null;
      }

      return this.findById(id);
    },

    async delete(id: number) {
      const affectedRows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .where("id", id)
        .delete();

      return affectedRows > 0;
    },

    async byIds(ids: number[]) {
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

    async findPendingOrders() {
      const rows = await knex<PersistedOrder>(ORDERS_TABLE_NAME)
        .select("*")
        .where("oracle_accept_to_relay", 1)
        .orderBy("id", "asc")
        .limit(MAX_PENDING);

      return rows.map((row) => normalizeOrderRow(row as StoredOrder));
    },

    async addSignatures(orderId: number, signatures: string[]) {
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
          "orders.source_payload",
          "orders.signature",
          "orders.status",
          "orders.oracle_accept_to_relay",
          "orders.id",
          "signatures.signature as order_signature"
        )
        .where("orders.oracle_accept_to_relay", 1)
        .orderBy("orders.id", "asc");

      const orders = new Map<number, StoredOrderWithSignatures>();
      for (const row of rows as Array<
        StoredOrder & { order_signature: string | null }
      >) {
        const id = Number(row.id);
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
