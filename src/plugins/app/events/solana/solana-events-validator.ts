import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Connection } from "@solana/web3.js";
import type { FastifyBaseLogger } from "fastify";
import type {
  VersionedTransactionResponse,
} from "@solana/web3.js";
import {
  decodeEventBytes,
  logLinesToEvents,
} from "./solana-program-logs.js";
import { bytesToHex } from "./bytes.js";
import {
  type SolanaEventPayload,
  type SolanaStoredEvent,
} from "../schemas/solana-event.js";
import { kEnvConfig, type EnvConfig } from "../../../infra/env.js";

type Logger = FastifyBaseLogger;

export type SolanaEventValidator = {
  validate(event: SolanaStoredEvent): Promise<void>;
};

export const kSolanaEventValidator = Symbol("app.solanaEventValidator");

type ValidatorDeps = {
  getTransaction: (
    signature: string
  ) => Promise<VersionedTransactionResponse | null>;
  getSignatureStatus?: (signature: string) => Promise<{
    confirmationStatus?: "processed" | "confirmed" | "finalized";
    err?: unknown;
  } | null>;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  commitment?: "processed" | "confirmed" | "finalized";
};

type NormalizedDecodedEvent = {
  type: "outbound" | "override-outbound";
  payload: SolanaEventPayload;
};

function normalizeDecodedEvent(
  decoded: ReturnType<typeof decodeEventBytes>
): NormalizedDecodedEvent | null {
  if (!decoded) {
    return null;
  }
  if (decoded.type === "outbound") {
    return {
      type: "outbound",
      payload: {
        networkIn: decoded.event.networkIn,
        networkOut: decoded.event.networkOut,
        tokenIn: bytesToHex(decoded.event.tokenIn),
        tokenOut: bytesToHex(decoded.event.tokenOut),
        fromAddress: bytesToHex(decoded.event.fromAddress),
        toAddress: bytesToHex(decoded.event.toAddress),
        amount: decoded.event.amount.toString(),
        relayerFee: decoded.event.relayerFee.toString(),
        nonce: bytesToHex(decoded.event.nonce),
      },
    };
  }
  return {
    type: "override-outbound",
    payload: {
      toAddress: bytesToHex(decoded.event.toAddress),
      relayerFee: decoded.event.relayerFee.toString(),
      nonce: bytesToHex(decoded.event.nonce),
    },
  };
}

function payloadMatches(
  expected: SolanaEventPayload,
  actual: SolanaEventPayload
): boolean {
  if ("networkIn" in expected && "networkIn" in actual) {
    return (
      expected.networkIn === actual.networkIn &&
      expected.networkOut === actual.networkOut &&
      expected.tokenIn === actual.tokenIn &&
      expected.tokenOut === actual.tokenOut &&
      expected.fromAddress === actual.fromAddress &&
      expected.toAddress === actual.toAddress &&
      expected.amount === actual.amount &&
      expected.relayerFee === actual.relayerFee &&
      expected.nonce === actual.nonce
    );
  }
  if (!("networkIn" in expected) && !("networkIn" in actual)) {
    return (
      expected.toAddress === actual.toAddress &&
      expected.relayerFee === actual.relayerFee &&
      expected.nonce === actual.nonce
    );
  }
  return false;
}

export function createSolanaEventValidator(deps: ValidatorDeps): SolanaEventValidator {
  const { getTransaction, getSignatureStatus, logger } = deps;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const commitment = deps.commitment ?? "confirmed";
  const retry = {
    maxAttempts: deps.retry?.maxAttempts ?? 6,
    baseDelayMs: deps.retry?.baseDelayMs ?? 500,
    maxDelayMs: deps.retry?.maxDelayMs ?? 4_000,
  };
  const commitmentRank = {
    processed: 1,
    confirmed: 2,
    finalized: 3,
  } as const;

  function hasRequiredCommitment(
    status: { confirmationStatus?: "processed" | "confirmed" | "finalized" } | null
  ) {
    if (!status?.confirmationStatus) {
      return false;
    }
    return (
      commitmentRank[status.confirmationStatus] >= commitmentRank[commitment]
    );
  }

  return {
    async validate(event: SolanaStoredEvent) {
      let tx: VersionedTransactionResponse | null = null;
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        tx = await getTransaction(event.signature);
        if (tx) {
          break;
        }
        if (getSignatureStatus) {
          const status = await getSignatureStatus(event.signature);
          if (status?.err) {
            logger.warn(
              { signature: event.signature, err: status.err },
              "Solana transaction failed"
            );
            throw new Error("Transaction failed");
          }
          if (hasRequiredCommitment(status)) {
            // Transaction should be available; fall through to retry.
          }
        }
        if (attempt < retry.maxAttempts) {
          const delay = Math.min(
            retry.maxDelayMs,
            retry.baseDelayMs * 2 ** (attempt - 1)
          );
          await sleep(delay);
        }
      }
      if (!tx) {
        throw new Error("Transaction not found or not finalized yet");
      }
      if (!tx.meta || tx.meta.err) {
        logger.warn(
          { signature: event.signature, err: tx.meta?.err },
          "Solana transaction failed"
        );
        throw new Error("Transaction failed");
      }

      const logs = tx.meta.logMessages ?? [];
      const dataLogs = logLinesToEvents(logs);
      const decoded = dataLogs
        .map((bytes) => normalizeDecodedEvent(decodeEventBytes(bytes)))
        .filter(Boolean) as NormalizedDecodedEvent[];

      const matches = decoded.some(
        (candidate) =>
          candidate.type === event.type &&
          payloadMatches(event.payload, candidate.payload)
      );
      if (!matches) {
        throw new Error("Transaction events do not match hub payload");
      }
    },
  };
}

export default fp(
  async function solanaEventsValidatorPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    const commitment = config.SOLANA_TX_COMMITMENT ?? "confirmed";
    const connection = new Connection(config.SOLANA_RPC_URL, commitment);
    const finality = commitment === "processed" ? "confirmed" : commitment;
    const validator = createSolanaEventValidator({
      getTransaction: (signature) =>
        connection.getTransaction(signature, {
          commitment: finality,
          maxSupportedTransactionVersion: 0,
        }),
      getSignatureStatus: async (signature) => {
        const response = await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        return response.value[0] ?? null;
      },
      commitment,
      retry: {
        maxAttempts: config.SOLANA_TX_RETRY_MAX_ATTEMPTS,
        baseDelayMs: config.SOLANA_TX_RETRY_BASE_MS,
        maxDelayMs: config.SOLANA_TX_RETRY_MAX_MS,
      },
      logger: fastify.log,
    });

    fastify.decorate(kSolanaEventValidator, validator);
  },
  {
    name: "solana-events-validator",
    dependencies: ["env"],
  }
);
