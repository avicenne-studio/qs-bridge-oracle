import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";

const HealthResponseSchema = Type.Object({
  status: Type.Literal("ok"),
  timestamp: Type.String({ format: "date-time" }),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async function handler() {
      const result = await fastify.knex
        .select(fastify.knex.raw("1 as result"))
        .first();

      if (result?.result !== 1) {
        const err = "Database health check failed";
        fastify.log.error(err);
        throw fastify.httpErrors.serviceUnavailable(err);
      }

      return {
        status: "ok" as const,
        timestamp: new Date().toISOString(),
      };
    }
  );
};

export default plugin;
