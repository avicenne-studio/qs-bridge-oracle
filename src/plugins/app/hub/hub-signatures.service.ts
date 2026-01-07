import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Static, Type } from "@sinclair/typebox";
import { SignatureSchema } from "../common/schemas/common.js";
import { OracleChain } from "../indexer/schemas/order.js";
import { RECOMMENDED_POLLING_DEFAULTS } from "../../infra/poller.js";

type OrderSignature = {
  orderId: number;
  dest: Static<typeof OracleChain>;
  signatures: string[];
};

type OrderSignaturesResponse = {
  data: OrderSignature[];
};

const RelayableSignatureSchema = Type.Object({
  orderId: Type.Integer({ minimum: 1 }),
  signatures: Type.Array(SignatureSchema, { minItems: 1 }),
});

const RelayableSignaturesSchema = Type.Object({
  data: Type.Array(RelayableSignatureSchema),
});

function parseHubUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function startHubSignaturePolling(
  fastify: FastifyInstance,
  urls: string[]
) {
  const primary = urls[0];
  const fallback = urls[1];
  const client = fastify.undiciGetClient.create();
  const defaults = RECOMMENDED_POLLING_DEFAULTS;

  const poller = fastify.poller.create({
    primary,
    fallback,
    fetchOne: (server, signal) =>
      client.getJson<OrderSignaturesResponse>(
        server,
        "/api/orders/signatures",
        signal
      ),
    onRound: async (response, context) => {
      if (!response) {
        fastify.log.warn(
          { primary: context.primary, fallback: context.fallback },
          "Hub signatures poll failed"
        );
        return;
      }

      if (!fastify.validation.isValid(RelayableSignaturesSchema, response)) {
        fastify.log.warn(
          { hubUsed: context.used },
          "Invalid hub signatures payload"
        );
        return;
      }

      const results = await Promise.all(
        response.data.map(async (order) => {
          try {
            const added = await fastify.ordersRepository.addSignatures(
              order.orderId,
              order.signatures
            );
            return { orderId: order.orderId, added: added.length };
          } catch (error) {
            fastify.log.error(
              { err: error, orderId: order.orderId },
              "Failed to persist hub signatures"
            );
            return { orderId: order.orderId, added: 0 };
          }
        })
      );

      const addedTotal = results.reduce((sum, result) => sum + result.added, 0);
      fastify.log.info(
        {
          hubUsed: context.used,
          count: response.data.length,
          addedTotal,
        },
        "Polled hub order signatures"
      );
    },
    intervalMs: defaults.intervalMs,
    requestTimeoutMs: defaults.requestTimeoutMs,
    jitterMs: defaults.jitterMs,
  });

  poller.start();
}

export default fp(
  async function hubSignatureService(fastify: FastifyInstance) {
    const urls = parseHubUrls(fastify.config.HUB_URLS);
    startHubSignaturePolling(fastify, urls);
  },
  {
    name: "hub-signature-service",
    dependencies: [
      "env",
      "polling",
      "undici-get-client",
      "orders-repository",
      "validation",
    ],
  }
);

export { parseHubUrls, RelayableSignatureSchema };
