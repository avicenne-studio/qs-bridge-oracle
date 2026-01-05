import { FastifyPluginAsyncTypebox, Type } from "@fastify/type-provider-typebox";
import { OracleOrderSchema } from "../../../plugins/app/indexer/schemas/order.js";

const OrdersResponseSchema = Type.Object({
  data: Type.Array(OracleOrderSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: OrdersResponseSchema,
        },
      },
    },
    async function handler() {
      try {
        const result = await fastify.ordersRepository.findPendingOrders();

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
