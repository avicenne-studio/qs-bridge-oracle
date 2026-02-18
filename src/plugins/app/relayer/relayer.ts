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
import {
  type SolanaRelayDeps,
  relayToSolana,
  buildSolanaRelayDeps,
} from "./relay-solana.js";

export type RelayerService = {
  relayPending(): Promise<void>;
};

export const kRelayerService = Symbol("app.relayerService");

type RelayResult = { trxHash: string };

function buildQubicUnlockPath(rpcUrl: string): { origin: string; path: string } {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const basePath = url.pathname === "/" ? "" : url.pathname;
  return { origin, path: `${basePath}/unlock` };
}

function buildQubicUnlockPayload(order: OracleOrder) {
  return {
    to: order.to,
    amount: order.amount,
    nonce: order.source_nonce,
  };
}

async function relayToQubic(
  order: OracleOrder,
  deps: { config: EnvConfig; client: ReturnType<UndiciClientService["create"]> }
): Promise<RelayResult> {
  const { origin, path } = buildQubicUnlockPath(deps.config.QUBIC_RPC_URL);
  const payload = buildQubicUnlockPayload(order);
  const body = await deps.client.postJson<{ trxHash?: string }>(
    origin,
    path,
    payload
  );
  if (!body.trxHash) {
    throw new Error("Relay response missing trxHash");
  }

  return { trxHash: body.trxHash };
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
