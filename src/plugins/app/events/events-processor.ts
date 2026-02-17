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
  kRelayerFeeAcceptance,
  type RelayerFeeAcceptance,
} from "../relayer/relayer-fee-acceptance.js";
import {
  kSolanaEventValidator,
  type SolanaEventValidator,
} from "./solana/solana-events-validator.js";
import { type SolanaStoredEvent } from "./solana/schemas/solana-event.js";
import {
  kQubicEventValidator,
  type QubicEventValidator,
} from "./qubic/qubic-events-validator.js";
import {
  type QubicStoredEvent,
  type QubicLockEventPayload,
  type QubicOverrideLockEventPayload,
  type QubicUnlockEventPayload,
} from "./qubic/schemas/qubic-event.js";
import { kValidation, type ValidationService } from "../common/validation.js";
import {
  createFailedOrderFromOutboundEvent,
  createSolanaOrderHandlers,
} from "./solana/solana-orders.js";
import { mapStoredEventToSolanaPayload } from "./solana/solana-event-mapper.js";
import { createQubicOrderHandlers } from "./qubic/qubic-orders.js";

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
    solanaValidator: SolanaEventValidator;
    qubicValidator: QubicEventValidator;
    config: EnvConfig;
    validation: ValidationService;
    relayerFeeAcceptance: RelayerFeeAcceptance;
    solanaHandlers: ReturnType<typeof createSolanaOrderHandlers>;
    qubicHandlers: ReturnType<typeof createQubicOrderHandlers>;
    logger: FastifyInstance["log"];
  }
) {
  const {
    solanaValidator,
    qubicValidator,
    solanaHandlers,
    qubicHandlers,
    logger,
  } = deps;

  if (event.chain === "solana") {
    const solanaEvent = event as SolanaStoredEvent;
    await solanaValidator.validate(solanaEvent);
    logger.info(
      { signature: event.signature, type: event.type, slot: event.slot },
      "Solana event validated"
    );
    const mapped = mapStoredEventToSolanaPayload(solanaEvent);
    if (mapped.type === "outbound") {
      await solanaHandlers.handleOutboundEvent(mapped.event, {
        signature: event.signature,
      });
    } else {
      await solanaHandlers.handleOverrideOutboundEvent(mapped.event, {
        signature: event.signature,
      });
    }
    return;
  }

  if (event.chain === "qubic") {
    const qubicEvent = event as QubicStoredEvent;
    await qubicValidator.validate(qubicEvent);
    logger.info(
      { signature: event.signature, type: event.type, slot: event.slot },
      "Qubic event validated"
    );
    if (qubicEvent.type === "lock") {
      await qubicHandlers.handleLockEvent(
        qubicEvent.payload as QubicLockEventPayload,
        {
          signature: qubicEvent.signature,
        }
      );
    } else if (qubicEvent.type === "override-lock") {
      await qubicHandlers.handleOverrideLockEvent(
        qubicEvent.payload as QubicOverrideLockEventPayload
      );
    } else {
      await qubicHandlers.handleUnlockEvent(
        qubicEvent.payload as QubicUnlockEventPayload,
        {
          signature: qubicEvent.signature,
        }
      );
    }
    return;
  }

  logger.warn({ chain: event.chain }, "Unsupported event chain");
}

async function handleFailure(opts: {
  event: StoredHubEvent;
  error: unknown;
  maxRetries: number;
  relayerMaxAttempts: number;
  eventsRepository: HubEventsRepository;
  ordersRepository: OrdersRepository;
  logger: FastifyInstance["log"];
}) {
  const {
    event,
    error,
    maxRetries,
    relayerMaxAttempts,
    eventsRepository,
    ordersRepository,
    logger,
  } = opts;
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

  if (status === "failed" && event.type === "outbound" && event.chain === "solana") {
    const publicReason = toPublicFailureReason(error);
    const mapped = mapStoredEventToSolanaPayload(event as SolanaStoredEvent);
    if (mapped.type !== "outbound") {
      return;
    }
    const failedOrder = createFailedOrderFromOutboundEvent(
      mapped.event,
      { signature: event.signature },
      publicReason,
      relayerMaxAttempts
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
    solanaValidator: SolanaEventValidator;
    qubicValidator: QubicEventValidator;
    config: EnvConfig;
    validation: ValidationService;
    relayerFeeAcceptance: RelayerFeeAcceptance;
    solanaHandlers: ReturnType<typeof createSolanaOrderHandlers>;
    qubicHandlers: ReturnType<typeof createQubicOrderHandlers>;
  }
) {
  const {
    eventsRepository,
    ordersRepository,
    signerService,
    solanaValidator,
    qubicValidator,
    config,
  } = deps;
  const pending = await eventsRepository.listPending(DEFAULT_PROCESS_LIMIT);
  if (pending.length === 0) {
    return;
  }

  for (const event of pending) {
    try {
      await processEvent(event, {
        ordersRepository,
        signerService,
        solanaValidator,
        qubicValidator,
        config,
        validation: deps.validation,
        relayerFeeAcceptance: deps.relayerFeeAcceptance,
        solanaHandlers: deps.solanaHandlers,
        qubicHandlers: deps.qubicHandlers,
        logger: fastify.log,
      });
      await eventsRepository.markDone(event.id);
    } catch (error) {
      await handleFailure({
        event,
        error,
        maxRetries: config.EVENT_MAX_RETRIES,
        relayerMaxAttempts: config.RELAYER_MAX_ATTEMPTS,
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
    solanaValidator: SolanaEventValidator;
    qubicValidator: QubicEventValidator;
    config: EnvConfig;
    validation: ValidationService;
    relayerFeeAcceptance: RelayerFeeAcceptance;
    solanaHandlers: ReturnType<typeof createSolanaOrderHandlers>;
    qubicHandlers: ReturnType<typeof createQubicOrderHandlers>;
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
    const solanaValidator =
      fastify.getDecorator<SolanaEventValidator>(kSolanaEventValidator);
    const qubicValidator =
      fastify.getDecorator<QubicEventValidator>(kQubicEventValidator);
    const validation =
      fastify.getDecorator<ValidationService>(kValidation);
    const relayerFeeAcceptance =
      fastify.getDecorator<RelayerFeeAcceptance>(kRelayerFeeAcceptance);
    const solanaHandlers = createSolanaOrderHandlers({
      ordersRepository,
      signerService,
      config: {
        SOLANA_BPS_FEE: config.SOLANA_BPS_FEE,
        RELAYER_MAX_ATTEMPTS: config.RELAYER_MAX_ATTEMPTS,
      },
      logger: fastify.log,
      validation,
      relayerFeeAcceptance,
    });
    const qubicHandlers = createQubicOrderHandlers({
      ordersRepository,
      logger: fastify.log,
      relayerFeeAcceptance,
      config: { RELAYER_MAX_ATTEMPTS: config.RELAYER_MAX_ATTEMPTS },
    });

    fastify.addHook("onReady", async () => {
      startProcessor(fastify, {
        eventsRepository,
        ordersRepository,
        signerService,
        solanaValidator,
        qubicValidator,
        config,
        validation,
        relayerFeeAcceptance,
        solanaHandlers,
        qubicHandlers,
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
      "relayerFeeAcceptance",
      "solana-events-validator",
      "qubic-events-validator",
    ],
  }
);
