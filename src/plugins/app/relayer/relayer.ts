import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import { kUndiciClient, type UndiciClientService } from "../../infra/undici-client.js";
import { kOrdersRepository, type OrdersRepository } from "../indexer/orders.repository.js";
import { OracleOrder } from "../indexer/schemas/order.js";
import { relayToQubic } from "./relay-qubic.js";
import { type SolanaRelayDeps, relayToSolana, buildSolanaRelayDeps } from "./relay-solana.js";
import { HttpError } from "../../infra/undici-client.js";
import { type SolanaErrorLike, collectSolanaErrorCodes } from "../common/solana/errors.js";

export type RelayerService = {
  relayPending(): Promise<void>;
};

export const kRelayerService = Symbol("app.relayerService");

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRateLimited(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.statusCode === 429;
  }
  if (error instanceof Error) {
    const codes = collectSolanaErrorCodes(error);
    if (codes.includes("8100002")) {
      return true;
    }
    const ctx = (error as SolanaErrorLike).context;
    if (ctx && String(ctx.statusCode) === "429") {
      return true;
    }
    const msg = error.message.toLowerCase();
    return msg.includes("too many requests") || msg.includes("429");
  }
  return false;
}

function computeBackoffMs(config: EnvConfig, nextAttempts: number): number {
  const maxExponent = Math.max(0, config.RELAYER_MAX_ATTEMPTS - 1);
  const exponent = Math.min(Math.max(0, nextAttempts - 1), maxExponent);
  const raw = config.RELAYER_BACKOFF_BASE_MS * Math.pow(2, exponent);
  return Math.min(config.RELAYER_BACKOFF_MAX_MS, Math.max(0, raw));
}

// @solana/errors: 4615009=ACCOUNT_ALREADY_INITIALIZED
function isLikelyAlreadyRelayed(error: unknown): boolean {
  return collectSolanaErrorCodes(error).includes("4615009");
}

// @solana/errors: 7050003=Attempt to debit an account but found no record of a prior credit (insufficient funds)
function isInsufficientFunds(error: unknown): boolean {
  return collectSolanaErrorCodes(error).includes("7050003");
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
  },
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
    const rateLimited = isRateLimited(error);
    if (rateLimited) {
      const backoffMs = computeBackoffMs(config, nextAttempts);
      logger.warn(
        { orderId: order.id, relayError: payload, backoffMs },
        "Relay rate-limited; backing off",
      );
      try {
        await ordersRepository.update(order.id, {
          relay_attempts: nextAttempts,
          status: "ready-for-relay",
          next_relay_at: new Date(Date.now() + backoffMs).toISOString(),
          last_relay_error: payload.message,
        });
      } catch (updateErr) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logger.error(
          { orderId: order.id, updateError: msg },
          "Failed to update order after rate limit",
        );
      }
      return;
    }
    const alreadyRelayed = isLikelyAlreadyRelayed(error);
    if (alreadyRelayed) {
      logger.warn(
        { orderId: order.id, relayError: payload },
        "Relay already completed by another oracle",
      );
      try {
        await ordersRepository.update(order.id, {
          status: "relayed",
        });
      } catch (updateErr) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logger.error(
          { orderId: order.id, updateError: msg },
          "Failed to update order after already-relayed detection",
        );
      }
      return;
    }
    if (isInsufficientFunds(error)) {
      logger.error(
        { orderId: order.id, relayError: payload },
        "Relay failed: insufficient funds on relayer wallet",
      );
      try {
        await ordersRepository.update(order.id, {
          relay_attempts: nextAttempts,
          status: "failed",
          failure_reason_public: "Insufficient funds on relayer wallet",
          last_relay_error: payload.message,
        });
      } catch (updateErr) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logger.error(
          { orderId: order.id, updateError: msg },
          "Failed to update order after insufficient funds",
        );
      }
      return;
    }

    logger.error({ orderId: order.id, relayError: payload }, "Relay failed");
    const shouldFail = nextAttempts >= config.RELAYER_MAX_ATTEMPTS;
    try {
      await ordersRepository.update(order.id, {
        relay_attempts: nextAttempts,
        status: shouldFail ? "failed" : "ready-for-relay",
        failure_reason_public: shouldFail ? "Relay failed" : undefined,
        last_relay_error: payload.message,
        next_relay_at: null,
      });
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      logger.error(
        { orderId: order.id, updateError: msg },
        "Failed to update order after relay failure",
      );
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
      const candidates = await ordersRepository.findReadyForRelay(config.RELAYER_MAX_ATTEMPTS);
      const delayMs = config.RELAYER_PER_ORDER_DELAY_MS;
      for (const [index, order] of candidates.entries()) {
        await relayOrder(order, {
          ordersRepository,
          config,
          client,
          logger,
          solanaDeps,
        });
        if (delayMs > 0 && index < candidates.length - 1) {
          await sleep(delayMs);
        }
      }
    },
  };
}

export function startRelayer(
  fastify: FastifyInstance,
  deps: {
    relayer: RelayerService;
    config: EnvConfig;
  },
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
    const ordersRepository = fastify.getDecorator<OrdersRepository>(kOrdersRepository);
    if (!config.RELAYER_ENABLED) {
      fastify.log.info("Relayer disabled by configuration");
      return;
    }
    const undiciClient = fastify.getDecorator<UndiciClientService>(kUndiciClient);

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
  },
);
