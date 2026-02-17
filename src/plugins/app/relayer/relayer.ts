import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { request } from "undici";
import { createHash, randomUUID } from "node:crypto";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../indexer/orders.repository.js";
import { OracleOrder } from "../indexer/schemas/order.js";

export type RelayerService = {
  relayPending(): Promise<void>;
};

export const kRelayerService = Symbol("app.relayerService");

type RelayResult = { trxHash: string };

function toPublicRelayFailure(): string {
  return "Relay failed";
}

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
  config: EnvConfig
): Promise<RelayResult> {
  const { origin, path } = buildQubicUnlockPath(config.QUBIC_RPC_URL);
  const payload = buildQubicUnlockPayload(order);
  const res = await request(`${origin}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
    },
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}`);
  }

  const body = (await res.body.json()) as { trxHash?: string };
  if (!body.trxHash) {
    throw new Error("Relay response missing trxHash");
  }

  return { trxHash: body.trxHash };
}

function relayToSolana(order: OracleOrder, logger: FastifyInstance["log"]): RelayResult {
  const trxHash = createHash("sha256").update(randomUUID()).digest("hex");
  logger.info(
    { orderId: order.id },
    "Solana relayer is not implemented; returning placeholder transaction hash"
  );
  // TODO: Replace placeholder transaction hash with actual Solana relay.
  return { trxHash };
}

function resolveMaxRelayAttempts(order: OracleOrder) {
  return order.max_relay_attempts;
}

async function relayOrder(
  order: OracleOrder,
  deps: {
    ordersRepository: OrdersRepository;
    config: EnvConfig;
    logger: FastifyInstance["log"];
  }
) {
  const { ordersRepository, config, logger } = deps;
  const maxRelayAttempts = resolveMaxRelayAttempts(order);
  const nextAttempts = order.relay_attempts + 1;

  try {
    const result =
      order.dest === "qubic"
        ? await relayToQubic(order, config)
        : relayToSolana(order, logger);

    await ordersRepository.update(order.id, {
      status: "relayed",
      destination_trx_hash: result.trxHash,
    });
    logger.info({ orderId: order.id }, "Order relayed successfully");
  } catch (error) {
    logger.error({ err: error, orderId: order.id }, "Relay failed");
    const shouldFail = nextAttempts >= maxRelayAttempts;

    await ordersRepository.update(order.id, {
      relay_attempts: nextAttempts,
      status: shouldFail ? "failed" : "ready-for-relay",
      failure_reason_public: shouldFail ? toPublicRelayFailure() : undefined,
    });
  }
}

export function createRelayerService(deps: {
  ordersRepository: OrdersRepository;
  config: EnvConfig;
  logger: FastifyInstance["log"];
}): RelayerService {
  const { ordersRepository, config, logger } = deps;

  return {
    async relayPending() {
      const candidates = await ordersRepository.findReadyForRelay();
      for (const order of candidates) {
        await relayOrder(order, { ordersRepository, config, logger });
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
    if (fastify.hasDecorator(kRelayerService)) {
      return;
    }
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const ordersRepository =
      fastify.getDecorator<OrdersRepository>(kOrdersRepository);

    const relayer = createRelayerService({
      ordersRepository,
      config,
      logger: fastify.log,
    });

    fastify.decorate(kRelayerService, relayer);

    fastify.addHook("onReady", async () => {
      startRelayer(fastify, { relayer, config });
    });
  },
  {
    name: "relayer",
    dependencies: ["env", "orders-repository"],
  }
);
