import { FastifyPluginAsyncTypebox, Type } from "@fastify/type-provider-typebox";
import { OracleOrderSchema } from "../../../plugins/app/indexer/schemas/order.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../plugins/app/indexer/orders.repository.js";

const OrdersResponseSchema = Type.Object({
  data: Type.Array(OracleOrderSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const ordersRepository =
    fastify.getDecorator<OrdersRepository>(kOrdersRepository);
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
        const result = await ordersRepository.findPendingOrders();

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
