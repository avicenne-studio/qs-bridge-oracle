import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";
import {
  kHubEventsRepository,
  type HubEventsRepository,
  type StoredHubEvent,
} from "./hub-events.repository.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../indexer/orders.repository.js";
import {
  kSignerService,
  type SignerService,
} from "../signer/signer.service.js";
import {
  kSolanaEventValidator,
  type SolanaEventValidator,
} from "./solana/solana-events-validator.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import {
  createFailedOrderFromOutboundEvent,
  createSolanaOrderHandlers,
} from "./solana/solana-orders.js";
import { mapStoredEventToSolanaPayload } from "./solana/solana-event-mapper.js";

const DEFAULT_PROCESS_LIMIT = 50;

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

export function toPublicFailureReason(error: unknown) {
  const message = normalizeErrorMessage(error);
  if (message.includes("Transaction failed")) {
    return "Transaction failed";
  }
  if (message.includes("Transaction not found")) {
    return "Transaction not found";
  }
  if (message.includes("do not match")) {
    return "Transaction data mismatch";
  }
  return "Event processing failed";
}

async function processEvent(
  event: StoredHubEvent,
  deps: {
    ordersRepository: OrdersRepository;
    signerService: SignerService;
    validator: SolanaEventValidator;
    config: EnvConfig;
    validation: ValidationService;
    logger: FastifyInstance["log"];
  }
) {
  const {
    ordersRepository,
    signerService,
    validator,
    config,
    validation,
    logger,
  } = deps;
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
    validation,
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

async function handleFailure(opts: {
  event: StoredHubEvent;
  error: unknown;
  maxRetries: number;
  eventsRepository: HubEventsRepository;
  ordersRepository: OrdersRepository;
  logger: FastifyInstance["log"];
}) {
  const { event, error, maxRetries, eventsRepository, ordersRepository, logger } =
    opts;
  const nextRetryCount = event.retryCount + 1;
  const failureReasonInternal = normalizeErrorMessage(error);
  const failureCode = event.type;
  const status = nextRetryCount >= maxRetries ? "failed" : "pending";

  await eventsRepository.recordFailure({
    id: event.id,
    retryCount: nextRetryCount,
    status,
    failureCode,
    failureReasonInternal,
  });

  if (status === "failed" && event.type === "outbound") {
    const publicReason = toPublicFailureReason(error);
    const mapped = mapStoredEventToSolanaPayload(event);
    if (mapped.type !== "outbound") {
      return;
    }
    const failedOrder = createFailedOrderFromOutboundEvent(
      mapped.event,
      { signature: event.signature },
      publicReason
    );
    const sourceNonce = failedOrder.source_nonce;
    const existing = await ordersRepository.findBySourceNonce(sourceNonce);
    if (existing) {
      logger.warn(
        { orderId: existing.id, eventId: event.id },
        "Failed event order already exists"
      );
      return;
    }
    await ordersRepository.create(failedOrder);
    logger.info(
      { orderId: failedOrder.id, eventId: event.id },
      "Stored failed order from outbound event"
    );
  }
}

async function processPendingEvents(
  fastify: FastifyInstance,
  deps: {
    eventsRepository: HubEventsRepository;
    ordersRepository: OrdersRepository;
    signerService: SignerService;
    validator: SolanaEventValidator;
    config: EnvConfig;
    validation: ValidationService;
  }
) {
  const { eventsRepository, ordersRepository, signerService, validator, config } =
    deps;
  const pending = await eventsRepository.listPending(DEFAULT_PROCESS_LIMIT);
  if (pending.length === 0) {
    return;
  }

  for (const event of pending) {
    try {
      await processEvent(event, {
        ordersRepository,
        signerService,
        validator,
        config,
        validation: deps.validation,
        logger: fastify.log,
      });
      await eventsRepository.markDone(event.id);
    } catch (error) {
      await handleFailure({
        event,
        error,
        maxRetries: config.EVENT_MAX_RETRIES,
        eventsRepository,
        ordersRepository,
        logger: fastify.log,
      });
    }
  }
}

function startProcessor(
  fastify: FastifyInstance,
  deps: {
    eventsRepository: HubEventsRepository;
    ordersRepository: OrdersRepository;
    signerService: SignerService;
    validator: SolanaEventValidator;
    config: EnvConfig;
    validation: ValidationService;
  }
) {
  let running = false;
  const runOnce = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await processPendingEvents(fastify, deps);
    } catch (error) {
      fastify.log.error({ err: error }, "Failed to process pending hub events");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runOnce, deps.config.EVENTS_PROCESS_INTERVAL_MS);
  fastify.addHook("onClose", async () => {
    clearInterval(timer);
  });

  queueMicrotask(() => {
    runOnce().catch(() => undefined);
  });
}

export default fp(
  async function hubEventsProcessor(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const eventsRepository =
      fastify.getDecorator<HubEventsRepository>(kHubEventsRepository);
    const ordersRepository =
      fastify.getDecorator<OrdersRepository>(kOrdersRepository);
    const signerService = fastify.getDecorator<SignerService>(kSignerService);
    const validator =
      fastify.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
    const validation =
      fastify.getDecorator<ValidationService>(kValidation);

    fastify.addHook("onReady", async () => {
      startProcessor(fastify, {
        eventsRepository,
        ordersRepository,
        signerService,
        validator,
        config,
        validation,
      });
    });
  },
  {
    name: "hub-events-processor",
    dependencies: [
      "env",
      "validation",
      "hub-events-repository",
      "orders-repository",
      "signer-service",
      "solana-events-validator",
    ],
  }
);
