import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
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
import {
  SolanaEventsResponseSchema,
  type SolanaEventsResponse,
  type SolanaStoredEvent,
} from "./schemas/solana-event.js";
import { parseHubUrls } from "../hub/hub-signatures.service.js";
import { createSolanaOrderHandlers } from "./solana/solana-orders.js";
import { hexToBytes, toU64BigInt } from "./solana/bytes.js";
import {
  kSignerService,
  type SignerService,
} from "../signer/signer.service.js";
import {
  kSolanaEventValidator,
  type SolanaEventValidator,
} from "./solana/solana-events-validator.js";

const DEFAULT_EVENTS_LIMIT = 50;

type HubEventsState = Map<string, number>;

function buildHubEventsPath(after: number, limit: number) {
  const params = new URLSearchParams({
    after: String(after),
    limit: String(limit),
  });
  return `/api/orders/events?${params.toString()}`;
}

function mapStoredEventToSolanaPayload(event: SolanaStoredEvent) {
  if (event.type === "outbound") {
    const payload = event.payload;
    if ("networkIn" in payload) {
      return {
        type: "outbound" as const,
        event: {
          networkIn: payload.networkIn,
          networkOut: payload.networkOut,
          tokenIn: hexToBytes(payload.tokenIn),
          tokenOut: hexToBytes(payload.tokenOut),
          fromAddress: hexToBytes(payload.fromAddress),
          toAddress: hexToBytes(payload.toAddress),
          amount: toU64BigInt(payload.amount, "amount"),
          relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
          nonce: hexToBytes(payload.nonce),
        },
      };
    }
  }
  const payload = event.payload;
  return {
    type: "override-outbound" as const,
    event: {
      toAddress: hexToBytes(payload.toAddress),
      relayerFee: toU64BigInt(payload.relayerFee, "relayerFee"),
      nonce: hexToBytes(payload.nonce),
    },
  };
}

async function processEvent(
  event: SolanaStoredEvent,
  ordersRepository: OrdersRepository,
  signerService: SignerService,
  validator: SolanaEventValidator,
  config: EnvConfig,
  logger: FastifyInstance["log"]
) {
  await validator.validate(event);
  logger.info(
    { signature: event.signature, type: event.type, slot: event.slot },
    "Solana event validated"
  );
  const handlers = createSolanaOrderHandlers({
    ordersRepository,
    signerService,
    config: { SOLANA_BPS_FEE: config.SOLANA_BPS_FEE },
    logger,
  });
  const mapped = mapStoredEventToSolanaPayload(event);
  if (mapped.type === "outbound") {
    await handlers.handleOutboundEvent(mapped.event, {
      signature: event.signature,
    });
  } else {
    await handlers.handleOverrideOutboundEvent(mapped.event, {
      signature: event.signature,
    });
  }
}

function startHubEventsPolling(
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
  const signerService = fastify.getDecorator<SignerService>(kSignerService);
  const validator =
    fastify.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
  const client = undiciGetClient.create();
  const defaults = RECOMMENDED_POLLING_DEFAULTS;
  const cursors: HubEventsState = new Map();
  const limit = DEFAULT_EVENTS_LIMIT;

  const pollerHandle = poller.create({
    primary,
    fallback,
    fetchOne: (server, signal) => {
      const after = cursors.get(server) ?? 0;
      return client.getJson<SolanaEventsResponse>(
        server,
        buildHubEventsPath(after, limit),
        signal
      );
    },
    onRound: async (response, context) => {
      if (!response) {
        fastify.log.warn(
          { primary: context.primary, fallback: context.fallback },
          "Hub events poll failed"
        );
        return;
      }

      if (!validation.isValid(SolanaEventsResponseSchema, response)) {
        fastify.log.warn(
          { hubUsed: context.used },
          "Invalid hub events payload"
        );
        return;
      }

      const usedHub = context.used;
      let lastCursor = cursors.get(usedHub) ?? 0;
      for (const event of response.data) {
        try {
          await processEvent(
            event,
            ordersRepository,
            signerService,
            validator,
            config,
            fastify.log
          );
          lastCursor = event.id;
          cursors.set(usedHub, lastCursor);
        } catch (error) {
          fastify.log.error(
            { err: error, eventId: event.id, signature: event.signature },
            "Failed to process hub event"
          );
          break;
        }
      }

      fastify.log.info(
        {
          hubUsed: usedHub,
          count: response.data.length,
          cursor: lastCursor,
        },
        "Polled hub events"
      );
    },
    intervalMs: defaults.intervalMs,
    requestTimeoutMs: defaults.requestTimeoutMs,
    jitterMs: defaults.jitterMs,
  });

  pollerHandle.start();
}

export default fp(
  async function hubEventsService(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const urls = parseHubUrls(config.HUB_URLS);
    startHubEventsPolling(fastify, urls);
  },
  {
    name: "hub-events-service",
    dependencies: [
      "env",
      "polling",
      "undici-get-client",
      "orders-repository",
      "validation",
      "signer-service",
      "solana-events-validator",
    ],
  }
);

export { buildHubEventsPath };
