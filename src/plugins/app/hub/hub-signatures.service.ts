import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { IdSchema, SignatureSchema } from "../common/schemas/common.js";
import {
  kPoller,
  RECOMMENDED_POLLING_DEFAULTS,
  type PollerService,
} from "../../infra/poller.js";
import {
  kUndiciGetClient,
  type UndiciGetClientService,
} from "../../infra/undici-get-client.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../indexer/orders.repository.js";

type OrderSignature = {
  orderId: string;
  signatures: string[];
};

type OrderSignaturesResponse = {
  data: OrderSignature[];
};

const RelayableSignatureSchema = Type.Object({
  orderId: IdSchema,
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
  const undiciGetClient =
    fastify.getDecorator<UndiciGetClientService>(kUndiciGetClient);
  const poller = fastify.getDecorator<PollerService>(kPoller);
  const validation = fastify.getDecorator<ValidationService>(kValidation);
  const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
  const ordersRepository =
    fastify.getDecorator<OrdersRepository>(kOrdersRepository);
  const client = undiciGetClient.create();
  const defaults = RECOMMENDED_POLLING_DEFAULTS;

  const pollerHandle = poller.create({
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

      if (!validation.isValid(RelayableSignaturesSchema, response)) {
        fastify.log.warn(
          { hubUsed: context.used },
          "Invalid hub signatures payload"
        );
        return;
      }

      const threshold = Math.max(
        1,
        Math.floor(config.ORACLE_SIGNATURE_THRESHOLD)
      );

      const results = await Promise.all(
        response.data.map(async (order) => {
          try {
            const added = await ordersRepository.addSignatures(
              order.orderId,
              order.signatures
            );
            let markedReady = false;
            if (order.signatures.length >= threshold) {
              const updated = await ordersRepository.markReadyForRelay(
                order.orderId
              );
              markedReady = updated !== null;
            }
            return {
              orderId: order.orderId,
              added: added.length,
              markedReady,
            };
          } catch (error) {
            fastify.log.error(
              { err: error, orderId: order.orderId },
              "Failed to persist hub signatures"
            );
            return { orderId: order.orderId, added: 0, markedReady: false };
          }
        })
      );

      const addedSignatures = results.reduce((sum, result) => sum + result.added, 0);
      const readyForRelayCount = results.reduce(
        (sum, result) => sum + (result.markedReady ? 1 : 0),
        0
      );
      fastify.log.info(
        {
          hubUsed: context.used,
          count: response.data.length,
          addedSignatures,
          readyForRelayCount,
        },
        "Polled hub order signatures"
      );
    },
    intervalMs: defaults.intervalMs * 5,
    requestTimeoutMs: defaults.requestTimeoutMs,
    jitterMs: defaults.jitterMs,
  });

  pollerHandle.start();
}

export default fp(
  async function hubSignatureService(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const urls = parseHubUrls(config.HUB_URLS);
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
