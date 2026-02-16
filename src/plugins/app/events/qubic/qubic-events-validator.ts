import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  kUndiciGetClient,
  type UndiciGetClient,
  type UndiciGetClientService,
} from "../../../infra/undici-get-client.js";
import { kEnvConfig, type EnvConfig } from "../../../infra/env.js";
import { kValidation, type ValidationService } from "../../common/validation.js";
import { StringSchema } from "../../common/schemas/common.js";
import { type QubicStoredEvent } from "./schemas/qubic-event.js";

export interface QubicEventValidator {
  validate(event: QubicStoredEvent): Promise<void>;
}

export const kQubicEventValidator = Symbol("app.qubicEventValidator");

type Logger = FastifyBaseLogger;

type QubicExpected = {
  type: QubicStoredEvent["type"];
  nonce: string;
  payload: QubicStoredEvent["payload"];
};

export type QubicTransactionResponse = {
  trxHash: string;
  matches: boolean;
  logs?: unknown[];
};

export type QubicTransactionFetcher = (
  signature: string,
  expected: QubicExpected
) => Promise<QubicTransactionResponse>;

const QubicTransactionResponseSchema = Type.Object(
  {
    trxHash: StringSchema,
    matches: Type.Boolean(),
  },
  { additionalProperties: true }
);

function buildTransactionsPath(basePath: string, signature: string, expected: QubicExpected) {
  const normalized = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  const params = new URLSearchParams();
  params.set("expected", JSON.stringify(expected));
  return `${normalized}/transactions/${encodeURIComponent(signature)}?${params.toString()}`;
}

export function createDefaultQubicTransactionFetcher(
  client: UndiciGetClient,
  rpcUrl: string
): QubicTransactionFetcher {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const basePath = url.pathname === "/" ? "" : url.pathname;

  return async (signature, expected) => {
    const path = buildTransactionsPath(basePath, signature, expected);
    return client.getJson<QubicTransactionResponse>(origin, path);
  };
}

export function createQubicEventValidator(deps: {
  fetchTransaction: QubicTransactionFetcher;
  logger: Logger;
  validation?: ValidationService;
}): QubicEventValidator {
  const { fetchTransaction, logger, validation } = deps;

  return {
    async validate(event: QubicStoredEvent) {
      const expected: QubicExpected = {
        type: event.type,
        nonce: event.nonce,
        payload: event.payload,
      };

      let response: QubicTransactionResponse;
      try {
        response = await fetchTransaction(event.signature, expected);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("404")) {
          throw new Error("Transaction not found");
        }
        logger.warn({ err: error }, "Qubic transaction fetch failed");
        throw error;
      }

      if (validation && !validation.isValid(QubicTransactionResponseSchema, response)) {
        throw new Error("Transaction response invalid");
      }

      if (!response.matches) {
        throw new Error("Transaction events do not match hub payload");
      }
    },
  };
}

export default fp(
  async function qubicEventsValidatorPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kQubicEventValidator)) {
      return;
    }
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const undiciGetClient =
      fastify.getDecorator<UndiciGetClientService>(kUndiciGetClient);
    const validation = fastify.getDecorator<ValidationService>(kValidation);
    const client = undiciGetClient.create();

    const validator = createQubicEventValidator({
      fetchTransaction: createDefaultQubicTransactionFetcher(
        client,
        config.QUBIC_RPC_URL
      ),
      logger: fastify.log,
      validation,
    });

    fastify.decorate(kQubicEventValidator, validator);
  },
  {
    name: "qubic-events-validator",
    dependencies: ["env", "undici-get-client", "validation"],
  }
);
