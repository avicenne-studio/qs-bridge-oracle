import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import knex, { Knex } from "knex";

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
  },
  { name: "knex", dependencies: ["env"] }
);
