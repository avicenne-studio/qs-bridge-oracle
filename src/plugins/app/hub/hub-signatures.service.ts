import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Static } from "@sinclair/typebox";
import { OracleChain } from "../indexer/schemas/order.js";
import { RECOMMENDED_POLLING_DEFAULTS } from "../../infra/poller.js";

type OrderSignature = {
  orderId: string;
  dest: Static<typeof OracleChain>;
  signatures: string[];
};

type OrderSignaturesResponse = {
  data: OrderSignature[];
};

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
    onRound: (response, context) => {
      if (!response) {
        fastify.log.warn(
          { primary: context.primary, fallback: context.fallback },
          "Hub signatures poll failed"
        );
        return;
      }

      // TODO: real signature gathering service
      fastify.log.info(
        {
          hubUsed: context.used,
          count: response.data.length,
          data: response.data,
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
    dependencies: ["env", "polling", "undici-get-client"],
  }
);

export { parseHubUrls };
