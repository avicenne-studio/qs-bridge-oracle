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
    logger.error({ err: error, orderId: order.id }, "Relay failed");
    const shouldFail = nextAttempts >= config.RELAYER_MAX_ATTEMPTS;

    await ordersRepository.update(order.id, {
      relay_attempts: nextAttempts,
      status: shouldFail ? "failed" : "ready-for-relay",
      failure_reason_public: shouldFail ? "Relay failed" : undefined,
    });
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
      fastify.log.error({ err: error }, "Relayer cycle failed");
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
