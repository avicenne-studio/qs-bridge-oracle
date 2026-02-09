import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";
import { EnvConfig, kEnvConfig } from "./env.js";
import { SIGNATURE_MAX_LENGTH } from "../app/common/schemas/common.js";
import {
  ORDER_SIGNATURES_TABLE_NAME,
  ORDERS_TABLE_NAME,
} from "../app/indexer/orders.repository.js";
import { HUB_NONCES_TABLE_NAME } from "../app/hub/hub-nonces.repository.js";
import {
  HUB_EVENTS_TABLE_NAME,
  HUB_EVENT_CURSORS_TABLE_NAME,
} from "../app/events/hub-events.repository.js";

export type KnexAccessor = {
  get(): Knex;
};

export const kKnex = Symbol("infra.knex");

export const autoConfig = (fastify: FastifyInstance): Knex.Config => {
  const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
  const filename = config.SQLITE_DB_FILE;

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
    const accessor: KnexAccessor = {
      // Knex is callable; wrapping avoids getDecorator binding it to Fastify.
      get: () => db,
    };

    fastify.decorate(kKnex, accessor);

    fastify.addHook("onClose", async (instance) => {
      const knexInstance = instance.getDecorator<KnexAccessor>(kKnex).get();
      await knexInstance.destroy();
    });

    fastify.addHook("onReady", async () => {
      const knexInstance = fastify.getDecorator<KnexAccessor>(kKnex).get();
      const hasTable = await knexInstance.schema.hasTable(ORDERS_TABLE_NAME);
      if (!hasTable) {
        await knexInstance.schema.createTable(ORDERS_TABLE_NAME, (table) => {
          table.string("id").primary().notNullable();
          table.string("source").notNullable();
          table.string("dest").notNullable();
          table.string("from").notNullable();
          table.string("to").notNullable();
          table.string("amount").notNullable();
          table.string("relayerFee").notNullable().defaultTo("0");
          table
            .string("origin_trx_hash", 255)
            .notNullable();
          table.string("source_nonce").nullable().unique();
          table.string("source_payload").nullable();
          table.string("signature", SIGNATURE_MAX_LENGTH).notNullable();
          table.string("failure_reason_public").nullable();
          table.string("status").notNullable().defaultTo("ready-for-relay");
          table.boolean("oracle_accept_to_relay").notNullable().defaultTo(true);
        });
      } else {
        const hasOriginHash = await knexInstance.schema.hasColumn(
          ORDERS_TABLE_NAME,
          "origin_trx_hash"
        );
        if (!hasOriginHash) {
          await knexInstance.schema.alterTable(ORDERS_TABLE_NAME, (table) => {
            table
              .string("origin_trx_hash", 255)
              .notNullable()
              .defaultTo("unknown");
          });
        }
        const hasFailureReason = await knexInstance.schema.hasColumn(
          ORDERS_TABLE_NAME,
          "failure_reason_public"
        );
        if (!hasFailureReason) {
          await knexInstance.schema.alterTable(ORDERS_TABLE_NAME, (table) => {
            table.string("failure_reason_public").nullable();
          });
        }
      }

      const hasSignaturesTable = await knexInstance.schema.hasTable(
        ORDER_SIGNATURES_TABLE_NAME
      );
      if (!hasSignaturesTable) {
        await knexInstance.schema.createTable(
          ORDER_SIGNATURES_TABLE_NAME,
          (table) => {
            table.string("id").primary().notNullable();
            table.string("order_id").notNullable();
            table.string("signature").notNullable();
            table.unique(["order_id", "signature"]);
          }
        );
      }

      const hasNoncesTable = await knexInstance.schema.hasTable(
        HUB_NONCES_TABLE_NAME
      );
      if (!hasNoncesTable) {
        await knexInstance.schema.createTable(
          HUB_NONCES_TABLE_NAME,
          (table) => {
            table.string("hubId").notNullable();
            table.string("kid").notNullable();
            table.string("nonce").notNullable();
            table.integer("ts").notNullable();
            table.primary(["hubId", "kid", "nonce"]);
          }
        );
      }

      const hasHubEventsTable = await knexInstance.schema.hasTable(
        HUB_EVENTS_TABLE_NAME
      );
      if (!hasHubEventsTable) {
        await knexInstance.schema.createTable(HUB_EVENTS_TABLE_NAME, (table) => {
          table.increments("id");
          table.string("hub_url").notNullable();
          table.string("signature").notNullable();
          table.integer("slot").nullable();
          table.string("chain").notNullable();
          table.string("type").notNullable();
          table.string("nonce").notNullable();
          table.text("payload").notNullable();
          table
            .timestamp("created_at", { useTz: false })
            .notNullable();
          table.string("status").notNullable().defaultTo("pending");
          table.integer("retry_count").notNullable().defaultTo(0);
          table.string("failure_code").nullable();
          table.text("failure_reason_internal").nullable();
          table
            .timestamp("last_failure_at", { useTz: false })
            .nullable();
          table
            .timestamp("processed_at", { useTz: false })
            .nullable();
          table.unique(["signature", "type", "nonce"]);
        });
      }

      const hasHubEventCursorsTable = await knexInstance.schema.hasTable(
        HUB_EVENT_CURSORS_TABLE_NAME
      );
      if (!hasHubEventCursorsTable) {
        await knexInstance.schema.createTable(
          HUB_EVENT_CURSORS_TABLE_NAME,
          (table) => {
            table.string("hub_url").primary().notNullable();
            table.string("last_created_at").notNullable();
            table.integer("last_id").notNullable().defaultTo(0);
            table
              .timestamp("updated_at", { useTz: false })
              .notNullable()
              .defaultTo(knexInstance.fn.now());
          }
        );
      }
    });
  },
  { name: "knex", dependencies: ["env"] }
);
