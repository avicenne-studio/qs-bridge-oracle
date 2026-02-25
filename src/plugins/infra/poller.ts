import fp from "fastify-plugin";
import { FastifyInstance, type FastifyBaseLogger } from "fastify";
import { kEnvConfig, type EnvConfig } from "./env.js";
import { formatErrorPayload } from "../common/error-format.js";

export type Fetcher<TResponse> = (
  server: string,
  signal: AbortSignal
) => Promise<TResponse>;

export type PollerOptions = {
  intervalMs: number;
  requestTimeoutMs: number;
  jitterMs?: number;
};

export type PollerRoundContext = {
  round: number;
  startedAt: number;
  primary: string;
  fallback?: string;
  used: string;
};

export type PollerRoundHandler<TResponse> = (
  response: TResponse | null,
  context: PollerRoundContext
) => Promise<void> | void;

export type CreatePollerConfig<TResponse> = PollerOptions & {
  primary: string;
  fallback?: string;
  fetchOne: Fetcher<TResponse>;
  onRound: PollerRoundHandler<TResponse>;
  logger: FastifyBaseLogger;
};

export type PollerHandle = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
};

export type PollerService = {
  defaults: Readonly<PollerOptions>;
  create<TResponse>(config: CreatePollerConfig<TResponse>): PollerHandle;
};

export const kPoller = Symbol("infra.poller");

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function createPoller<TResponse>(
  config: CreatePollerConfig<TResponse>
): PollerHandle {
  const {
    primary,
    fallback,
    fetchOne,
    onRound,
    intervalMs,
    requestTimeoutMs,
    jitterMs,
    logger,
  } = config;

  let runningPromise: Promise<void> | null = null;
  let shouldRun = false;

  function logFetchError(error: unknown, server: string) {
    const err = formatErrorPayload(error);
    logger.error({ error: err, server }, "Poller fetchOne error");
  }

  async function loop() {
    let round = 0;
    while (shouldRun) {
      round += 1;
      const startedAt = Date.now();

      if (jitterMs && jitterMs > 0) {
        const delay = Math.floor(Math.random() * (jitterMs + 1));
        await sleep(delay);
      }

      let response: TResponse | null = null;
      let used: string = primary;
      let primaryError: unknown | null = null;
      let fallbackError: unknown | null = null;

      try {
        response = await withTimeout(requestTimeoutMs, (signal) =>
          fetchOne(primary, signal)
        );
        used = primary;
      } catch (error) {
        primaryError = error;
        if (fallback) {
          try {
            response = await withTimeout(requestTimeoutMs, (signal) =>
              fetchOne(fallback, signal)
            );
            used = fallback;
          } catch (fallbackErr) {
            fallbackError = fallbackErr;
            response = null;
            used = fallback;
          }
        } else {
          used = primary;
        }
      }

      if (primaryError) {
        logFetchError(primaryError, primary);
      }

      if (fallbackError && fallback) {
        logFetchError(fallbackError, fallback);
      }

      await onRound(response, {
        round,
        startedAt,
        primary,
        fallback,
        used,
      });

      const elapsed = Date.now() - startedAt;
      const waitFor = Math.max(0, intervalMs - elapsed);
      if (waitFor > 0) {
        await sleep(waitFor);
      }
    }
  }

  return {
    start() {
      if (runningPromise) {
        throw new Error("Poller already started");
      }
      shouldRun = true;
      runningPromise = loop().finally(() => {
        runningPromise = null;
        shouldRun = false;
      });
    },
    async stop() {
      if (!runningPromise) {
        shouldRun = false;
        return;
      }
      shouldRun = false;
      try {
        await runningPromise;
      } finally {
        runningPromise = null;
      }
    },
    isRunning() {
      return runningPromise !== null;
    },
  };
}

export default fp(
  function pollingPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kPoller)) {
      return;
    }
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const defaults: Readonly<PollerOptions> = Object.freeze({
      intervalMs: config.POLLER_INTERVAL_MS,
      requestTimeoutMs: config.POLLER_REQUEST_TIMEOUT_MS,
      jitterMs: config.POLLER_JITTER_MS,
    });
    const handles = new Set<PollerHandle>();

    fastify.decorate(kPoller, {
      defaults,
      create<TResponse>(config: CreatePollerConfig<TResponse>) {
        const handle = createPoller(config);
        handles.add(handle);
        return handle;
      },
    });

    fastify.addHook("onClose", async () => {
      await Promise.all(
        [...handles].map(async (handle) => {
          await handle.stop();
        })
      );
      handles.clear();
    });
  },
  {
    name: "polling",
  }
);
