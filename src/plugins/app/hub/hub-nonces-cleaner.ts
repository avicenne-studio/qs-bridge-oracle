import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import {
  HUB_AUTH_TIME_SKEW_SECONDS,
  HUB_NONCE_CLEANUP_BUFFER_SECONDS,
  HUB_NONCE_CLEANUP_INTERVAL_MS,
} from "./hub-verifier.js";
import {
  kHubNoncesRepository,
  type HubNoncesRepository,
} from "./hub-nonces.repository.js";

export default fp(
  async function hubNoncesCleanerPlugin(fastify: FastifyInstance) {
    const hubNoncesRepository =
      fastify.getDecorator<HubNoncesRepository>(kHubNoncesRepository);
    let interval: NodeJS.Timeout | null = null;

    const cleanup = async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const cutoff =
        nowSeconds - HUB_AUTH_TIME_SKEW_SECONDS - HUB_NONCE_CLEANUP_BUFFER_SECONDS;
      try {
        await hubNoncesRepository.deleteExpired(cutoff);
      } catch (error) {
        fastify.log.warn({ err: error }, "Failed to cleanup hub nonces");
      }
    };

    fastify.addHook("onReady", async () => {
      await cleanup();
      interval = setInterval(cleanup, HUB_NONCE_CLEANUP_INTERVAL_MS);
      interval.unref();
    });

    fastify.addHook("onClose", async () => {
      if (interval) {
        clearInterval(interval);
      }
    });
  },
  {
    name: "hub-nonces-cleaner",
    dependencies: ["hub-nonces-repository"],
  }
);
