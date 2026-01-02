import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import { OracleOrderSchema } from "../../../plugins/app/indexer/schemas/order.js";

const OrdersRequestSchema = Type.Object({
  ids: Type.Array(Type.Integer({ minimum: 1 }), {
    minItems: 1,
    maxItems: 100,
  }),
});

const OrdersResponseSchema = Type.Object({
  data: Type.Array(OracleOrderSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.post(
    "/",
    {
      schema: {
        body: OrdersRequestSchema,
        response: {
          200: OrdersResponseSchema,
        },
      },
    },
    async function handler(request) {
      try {
        const result = await fastify.ordersRepository.byIds(request.body.ids);

        return {
          data: result,
        };
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to list orders");
        throw fastify.httpErrors.internalServerError("Failed to list orders");
      }
    }
  );
};

export default plugin;
