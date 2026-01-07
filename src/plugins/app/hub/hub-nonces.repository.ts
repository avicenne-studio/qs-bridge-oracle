import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

export const HUB_NONCES_TABLE_NAME = "seen_nonces";

declare module "fastify" {
  interface FastifyInstance {
    hubNoncesRepository: ReturnType<typeof createRepository>;
  }
}

type NonceRecord = {
  hubId: string;
  kid: string;
  nonce: string;
  ts: number;
};

function createRepository(fastify: FastifyInstance) {
  const knex = fastify.knex;

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
    fastify.decorate("hubNoncesRepository", createRepository(fastify));
  },
  {
    name: "hub-nonces-repository",
    dependencies: ["knex"],
  }
);
