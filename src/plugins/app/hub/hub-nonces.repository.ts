import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kKnex, type KnexAccessor } from "../../infra/@knex.js";

export const HUB_NONCES_TABLE_NAME = "seen_nonces";

export const kHubNoncesRepository = Symbol("app.hubNoncesRepository");
export type HubNoncesRepository = ReturnType<typeof createRepository>;

type NonceRecord = {
  hubId: string;
  kid: string;
  nonce: string;
  ts: number;
};

function createRepository(fastify: FastifyInstance) {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();

  return {
    async exists(hubId: string, kid: string, nonce: string) {
      const row = await knex<NonceRecord>(HUB_NONCES_TABLE_NAME)
        .select("nonce")
        .where({ hubId, kid, nonce })
        .first();
      return Boolean(row);
    },

    async insert(entry: NonceRecord) {
      await knex<NonceRecord>(HUB_NONCES_TABLE_NAME).insert(entry);
    },

    async deleteExpired(cutoffTs: number) {
      return knex<NonceRecord>(HUB_NONCES_TABLE_NAME)
        .where("ts", "<", cutoffTs)
        .delete();
    },
  };
}

export default fp(
  function hubNoncesRepositoryPlugin(fastify: FastifyInstance) {
    fastify.decorate(kHubNoncesRepository, createRepository(fastify));
  },
  {
    name: "hub-nonces-repository",
    dependencies: ["knex"],
  }
);
