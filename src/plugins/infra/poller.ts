import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";

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
  used?: string;
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
};

export type PollerHandle = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
};

export const RECOMMENDED_POLLING_DEFAULTS: Readonly<PollerOptions> =
  Object.freeze({
    intervalMs: 3000,
    requestTimeoutMs: 700,
    jitterMs: 25,
  });

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
  } = config;

  let runningPromise: Promise<void> | null = null;
  let shouldRun = false;

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
      let used: string | undefined;

      try {
        response = await withTimeout(requestTimeoutMs, (signal) =>
          fetchOne(primary, signal)
        );
        used = primary;
      } catch {
        if (fallback) {
          try {
            response = await withTimeout(requestTimeoutMs, (signal) =>
              fetchOne(fallback, signal)
            );
            used = fallback;
          } catch {
            response = null;
          }
        }
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
    const handles = new Set<PollerHandle>();

    fastify.decorate(kPoller, {
      defaults: RECOMMENDED_POLLING_DEFAULTS,
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
