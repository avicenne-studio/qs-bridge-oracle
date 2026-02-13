import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kPoller, type PollerService } from "../../infra/poller.js";
import {
  kUndiciGetClient,
  type UndiciGetClientService,
} from "../../infra/undici-get-client.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import {
  kHubEventsRepository,
  kHubEventCursorsRepository,
  type HubEventCursor,
  type HubEventsRepository,
  type HubEventCursorsRepository,
  type NewHubEvent,
} from "./hub-events.repository.js";
import {
  HubEventsResponseSchema,
  type HubEventsResponse,
} from "./schemas/hub-event.js";
import { parseHubUrls } from "../hub/hub-signatures.service.js";

const DEFAULT_EVENTS_LIMIT = 50;

type HubEventsState = Map<string, HubEventCursor>;

function buildHubEventsPath(
  createdAfter: string,
  afterId: number,
  limit: number
) {
  const params = new URLSearchParams({
    created_after: createdAfter,
    after_id: String(afterId),
    limit: String(limit),
  });
  return `/api/orders/events?${params.toString()}`;
}

function formatSqliteTimestamp(date: Date) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export async function loadInitialCursor(
  hubUrl: string,
  deps: {
    eventsRepository: HubEventsRepository;
    cursorsRepository: HubEventCursorsRepository;
    lookbackDays: number;
  }
): Promise<HubEventCursor> {
  const { eventsRepository, cursorsRepository, lookbackDays } = deps;
  const existing = await cursorsRepository.get(hubUrl);
  if (existing) {
    return existing;
  }
  const latest = await eventsRepository.findLatestCursor(hubUrl);
  if (latest) {
    await cursorsRepository.upsert(latest);
    return latest;
  }

  const fallbackDate = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000
  );
  const fallback = {
    hubUrl,
    lastCreatedAt: formatSqliteTimestamp(fallbackDate),
    lastId: 0,
  };
  await cursorsRepository.upsert(fallback);
  return fallback;
}

async function startHubEventsPolling(
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
  const eventsRepository =
    fastify.getDecorator<HubEventsRepository>(kHubEventsRepository);
  const cursorsRepository =
    fastify.getDecorator<HubEventCursorsRepository>(kHubEventCursorsRepository);
  const client = undiciGetClient.create();
  const defaults = poller.defaults;
  const cursors: HubEventsState = new Map();
  const limit = DEFAULT_EVENTS_LIMIT;

  await Promise.all(
    urls.map(async (url) => {
      const cursor = await loadInitialCursor(url, {
        eventsRepository,
        cursorsRepository,
        lookbackDays: config.EVENTS_LOOKBACK_DAYS,
      });
      cursors.set(url, cursor);
    })
  );

  const pollerHandle = poller.create({
    primary,
    fallback,
    fetchOne: (server, signal) => {
      const cursor = cursors.get(server)!;
      const createdAfter = cursor.lastCreatedAt;
      const afterId = cursor.lastId;
      return client.getJson<HubEventsResponse>(
        server,
        buildHubEventsPath(createdAfter, afterId, limit),
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

      if (!validation.isValid(HubEventsResponseSchema, response)) {
        fastify.log.warn(
          { hubUsed: context.used },
          "Invalid hub events payload"
        );
        return;
      }

      const usedHub = context.used;
      const cursor = cursors.get(usedHub)!;
      let lastCreatedAt = cursor.lastCreatedAt;
      let lastId = cursor.lastId;
      for (const event of response.data) {
        try {
          await eventsRepository.upsert({
            hubUrl: usedHub,
            signature: event.signature,
            slot: event.slot ?? null,
            chain: event.chain,
            type: event.type,
            nonce: event.nonce,
            payload: event.payload,
            createdAt: event.createdAt,
          } as NewHubEvent);
          lastCreatedAt = event.createdAt;
          lastId = event.id;
        } catch (error) {
          fastify.log.error(
            { err: error, eventId: event.id, signature: event.signature },
            "Failed to persist hub event"
          );
          break;
        }
      }

      if (response.data.length > 0) {
        const nextCursor = {
          hubUrl: usedHub,
          lastCreatedAt,
          lastId,
        };
        cursors.set(usedHub, nextCursor);
        await cursorsRepository.upsert(nextCursor);
      }

      fastify.log.info(
        {
          hubUsed: usedHub,
          count: response.data.length,
          cursor: { createdAt: lastCreatedAt, id: lastId },
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
    fastify.addHook("onReady", async () => {
      await startHubEventsPolling(fastify, urls);
    });
  },
  {
    name: "hub-events-service",
    dependencies: [
      "env",
      "polling",
      "undici-get-client",
      "hub-events-repository",
      "validation",
    ],
  }
);

export { buildHubEventsPath };
