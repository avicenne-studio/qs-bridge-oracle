import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";
import { SIGNATURE_MAX_LENGTH } from "../app/common/schemas/common.js";
import {
  ORDER_SIGNATURES_TABLE_NAME,
  ORDERS_TABLE_NAME,
} from "../app/indexer/orders.repository.js";
import { HUB_NONCES_TABLE_NAME } from "../app/hub/hub-nonces.repository.js";

declare module "fastify" {
  export interface FastifyInstance {
    knex: Knex;
  }
}

export const autoConfig = (fastify: FastifyInstance): Knex.Config => {
  const filename = fastify.config.SQLITE_DB_FILE;

  return {
    client: "better-sqlite3",
    connection: {
      filename,
    },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
  };
};

export default fp(
  async (fastify: FastifyInstance, opts: Knex.Config) => {
    const db = knex(opts);
    fastify.decorate("knex", db);

    fastify.addHook("onClose", async (instance) => {
      await instance.knex.destroy();
    });

    fastify.addHook("onReady", async () => {
      const hasTable = await fastify.knex.schema.hasTable(ORDERS_TABLE_NAME);
      if (!hasTable) {
        await fastify.knex.schema.createTable(ORDERS_TABLE_NAME, (table) => {
          table.integer("id").primary().notNullable();
          table.string("source").notNullable();
          table.string("dest").notNullable();
          table.string("from").notNullable();
          table.string("to").notNullable();
          table.float("amount").notNullable();
          table.string("signature", SIGNATURE_MAX_LENGTH).notNullable();
          table.string("status").notNullable().defaultTo("ready-for-relay");
          table
            .boolean("oracle_accept_to_relay")
            .notNullable()
            .defaultTo(true);
        });
      }
      
      const hasSignaturesTable = await fastify.knex.schema.hasTable(
        ORDER_SIGNATURES_TABLE_NAME
      );
      if (!hasSignaturesTable) {
        await fastify.knex.schema.createTable(
          ORDER_SIGNATURES_TABLE_NAME,
          (table) => {
            table.increments("id");
            table.integer("order_id").notNullable();
            table.string("signature").notNullable();
            table.unique(["order_id", "signature"]);
          }
        );
      }

      const hasNoncesTable = await fastify.knex.schema.hasTable(
        HUB_NONCES_TABLE_NAME
      );
      if (!hasNoncesTable) {
        await fastify.knex.schema.createTable(HUB_NONCES_TABLE_NAME, (table) => {
          table.string("hubId").notNullable();
          table.string("kid").notNullable();
          table.string("nonce").notNullable();
          table.integer("ts").notNullable();
          table.primary(["hubId", "kid", "nonce"]);
        });
      }
    });
  },
  { name: "knex", dependencies: ["env"] }
);
