import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  kKnex,
  type KnexAccessor,
} from "../../../plugins/infra/@knex.js";
import {
  kEnvConfig,
  type EnvConfig,
} from "../../../plugins/infra/env.js";

const HealthResponseSchema = Type.Object({
  status: Type.Literal("ok"),
  timestamp: Type.String({ format: "date-time" }),
  relayerFeeSolana: Type.String({ pattern: "^[0-9]+$" }),
  relayerFeeQubic: Type.String({ pattern: "^[0-9]+$" }),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const knex = fastify.getDecorator<KnexAccessor>(kKnex).get();
  const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
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
      const result = await knex
        .select(knex.raw("1 as result"))
        .first();

      if (result?.result !== 1) {
        const err = "Database health check failed";
        fastify.log.error(err);
        throw fastify.httpErrors.serviceUnavailable(err);
      }

      return {
        status: "ok" as const,
        timestamp: new Date().toISOString(),
        relayerFeeSolana: config.RELAYER_FEE_SOLANA,
        relayerFeeQubic: config.RELAYER_FEE_QUBIC,
      };
    }
  );
};

export default plugin;
