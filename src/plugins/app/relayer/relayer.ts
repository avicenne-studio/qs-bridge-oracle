import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import {
  kUndiciClient,
  type UndiciClientService,
} from "../../infra/undici-client.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../indexer/orders.repository.js";
import { OracleOrder } from "../indexer/schemas/order.js";
import { relayToQubic } from "./relay-qubic.js";
import {
  type SolanaRelayDeps,
  relayToSolana,
  buildSolanaRelayDeps,
} from "./relay-solana.js";

export type RelayerService = {
  relayPending(): Promise<void>;
};

export const kRelayerService = Symbol("app.relayerService");

/** Solana error codes that usually mean another oracle already relayed (account already initialized, etc.). */
const ALREADY_RELAYED_CODES = ["7050003", "4615009", "-32002"];
const ALREADY_RELAYED_MESSAGES = ["already been initialized", "uninitialized account"];

function isLikelyAlreadyRelayed(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (ALREADY_RELAYED_MESSAGES.some((m) => msg.includes(m))) {
    return true;
  }
  if (ALREADY_RELAYED_CODES.some((c) => msg.includes(c))) {
    return true;
  }
  return false;
}

function toRelayErrorPayload(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const ctx = (error as { context?: { __code?: number } }).context;
    const code =
      typeof ctx === "object" && ctx !== null && ctx.__code !== undefined
        ? String(ctx.__code)
        : undefined;
    return { message: error.message, ...(code && { code }) };
  }
  return { message: String(error) };
}

async function relayOrder(
  order: OracleOrder,
  deps: {
    ordersRepository: OrdersRepository;
    config: EnvConfig;
    client: ReturnType<UndiciClientService["create"]>;
    logger: FastifyInstance["log"];
    solanaDeps: SolanaRelayDeps;
  }
) {
  const { ordersRepository, config, client, logger, solanaDeps } = deps;
  const nextAttempts = order.relay_attempts + 1;

  try {
    const result =
      order.dest === "qubic"
        ? await relayToQubic(order, { config, client })
        : await relayToSolana(order, solanaDeps);

    await ordersRepository.update(order.id, {
      status: "relayed",
      destination_trx_hash: result.trxHash,
    });
    logger.info({ orderId: order.id }, "Order relayed successfully");
  } catch (error) {
    const payload = toRelayErrorPayload(error);
    const alreadyRelayed = isLikelyAlreadyRelayed(error);
    if (alreadyRelayed) {
      logger.warn(
        { orderId: order.id, relayError: payload },
        "Relay already completed by another oracle"
      );
      try {
        await ordersRepository.update(order.id, {
          status: "relayed",
        });
      } catch (updateErr) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logger.error({ orderId: order.id, updateError: msg }, "Failed to update order after already-relayed detection");
      }
      return;
    }

    logger.error(
      { orderId: order.id, relayError: payload },
      "Relay failed"
    );
    const shouldFail = nextAttempts >= config.RELAYER_MAX_ATTEMPTS;
    try {
      await ordersRepository.update(order.id, {
        relay_attempts: nextAttempts,
        status: shouldFail ? "failed" : "ready-for-relay",
        failure_reason_public: shouldFail ? "Relay failed" : undefined,
      });
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logger.error({ orderId: order.id, updateError: msg }, "Failed to update order after relay failure");
    }
  }
}

export function createRelayerService(deps: {
  ordersRepository: OrdersRepository;
  config: EnvConfig;
  undiciClient: UndiciClientService;
  logger: FastifyInstance["log"];
  solanaDeps: SolanaRelayDeps;
}): RelayerService {
  const { ordersRepository, config, undiciClient, logger, solanaDeps } = deps;
  const client = undiciClient.create();

  return {
    async relayPending() {
      const candidates = await ordersRepository.findReadyForRelay(
        config.RELAYER_MAX_ATTEMPTS
      );
      for (const order of candidates) {
        await relayOrder(order, {
          ordersRepository,
          config,
          client,
          logger,
          solanaDeps,
        });
      }
    },
  };
}

export function startRelayer(
  fastify: FastifyInstance,
  deps: {
    relayer: RelayerService;
    config: EnvConfig;
  }
) {
  let running = false;
  const runOnce = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await deps.relayer.relayPending();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error({ relayCycleError: message }, "Relayer cycle failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, deps.config.RELAYER_PROCESS_INTERVAL_MS);
  fastify.addHook("onClose", async () => {
    clearInterval(timer);
  });

  queueMicrotask(() => {
    runOnce().catch(() => undefined);
  });
}

export default fp(
  async function relayerPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const ordersRepository =
      fastify.getDecorator<OrdersRepository>(kOrdersRepository);
    if (!config.RELAYER_ENABLED) {
      fastify.log.info("Relayer disabled by configuration");
      return;
    }
    const undiciClient =
      fastify.getDecorator<UndiciClientService>(kUndiciClient);

    const solanaDeps = await buildSolanaRelayDeps(fastify, config, ordersRepository);

    const relayer = createRelayerService({
      ordersRepository,
      config,
      undiciClient,
      logger: fastify.log,
      solanaDeps,
    });

    fastify.decorate(kRelayerService, relayer);

    fastify.addHook("onReady", async () => {
      startRelayer(fastify, { relayer, config });
    });
  },
  {
    name: "relayer",
    dependencies: ["env", "orders-repository", "undici-client", "signer-service", "validation"],
  }
);
