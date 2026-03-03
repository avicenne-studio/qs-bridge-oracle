import { TestContext } from "node:test";

type LoggerMethod = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type LoggerLike = Partial<Record<LoggerMethod, (...args: unknown[]) => unknown>>;

export function mockLogMethod(
  t: TestContext,
  logger: LoggerLike,
  method: LoggerMethod
) {
  return t.mock.method(logger as Record<LoggerMethod, (...args: unknown[]) => unknown>, method).mock;
}

export type LoggerMocks = {
  infoLogs: unknown[][];
  warnLogs: unknown[][];
  errorLogs: unknown[][];
};

export function makeLogger() {
  const logs: LoggerMocks = {
    infoLogs: [],
    warnLogs: [],
    errorLogs: [],
  };
  const logger = {
    info: (...args: unknown[]) => logs.infoLogs.push(args),
    warn: (...args: unknown[]) => logs.warnLogs.push(args),
    error: (...args: unknown[]) => logs.errorLogs.push(args),
  };
  return { logger, logs };
}
