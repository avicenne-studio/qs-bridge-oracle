import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { WebSocket } from "undici";
import {
  getAddressEncoder,
} from "@solana/kit";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../../clients/js/programs/qsBridge.js";
import { AsyncQueue } from "./async-queue.js";
import {
  decodeEventBytes,
  isKnownEventSize,
  logLinesToEvents,
} from "./solana-program-logs.js";
import {
  createSolanaOrderHandlers,
} from "./solana-orders.js";
import {
  createJsonRpcClient,
  parseJsonRpcMessage,
} from "./solana-ws-json-rpc.js";
import { kEnvConfig, type EnvConfig } from "../../../infra/env.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../indexer/orders.repository.js";
import {
  kSignerService,
  type SignerService,
} from "../../signer/signer.service.js";

type WebSocketListener = (event: { data?: unknown }) => void;

type WebSocketLike = {
  addEventListener(type: string, listener: WebSocketListener): void;
  removeEventListener(type: string, listener: WebSocketListener): void;
  send(payload: string): void;
  close(): void;
  readyState: number;
};

const contractAddressBytes = new Uint8Array(
  getAddressEncoder().encode(QS_BRIDGE_PROGRAM_ADDRESS)
);

type WebSocketFactory = (url: string) => WebSocketLike;

export function createDefaultSolanaWsFactory(
  WebSocketCtor: typeof WebSocket = WebSocket
): WebSocketFactory {
  return (url: string) => new WebSocketCtor(url) as WebSocketLike;
}

export function resolveSolanaWsFactory(
  instance: FastifyInstance & {
    solanaWsFactory?: WebSocketFactory;
    parent?: FastifyInstance & { solanaWsFactory?: WebSocketFactory };
  },
  defaultFactory: WebSocketFactory
): WebSocketFactory {
  return (
    instance.solanaWsFactory ??
    instance.parent?.solanaWsFactory ??
    defaultFactory
  );
}

export default fp(
  async function wsSolanaListener(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    if (!config.SOLANA_LISTENER_ENABLED) {
      fastify.log.info("Solana WS listener disabled by configuration");
      return;
    }

    const ordersRepository =
      fastify.getDecorator<OrdersRepository>(kOrdersRepository);
    const signerService =
      fastify.getDecorator<SignerService>(kSignerService);

    let ws: WebSocketLike | null = null;
    let subscriptionId: number | null = null;
    const queue = new AsyncQueue();
    const rpc = createJsonRpcClient((payload) => {
      if (ws) {
        ws.send(payload);
      }
    });

    let subscribeRequestId: number | null = null;
    const seenUnknownEventSizes = new Set<number>();
    const { handleOutboundEvent, handleOverrideOutboundEvent } =
      createSolanaOrderHandlers({
        ordersRepository,
        signerService,
        config: { SOLANA_BPS_FEE: config.SOLANA_BPS_FEE },
        logger: fastify.log,
        contractAddressBytes,
      });

    const sendRequest = (method: string, params?: unknown[]) =>
      rpc.sendRequest(method, params);

    const onMessage = (event: { data?: unknown }) => {
      let parsed;
      try {
        parsed = parseJsonRpcMessage(event.data);
      } catch (error) {
        fastify.log.warn({ err: error }, "Solana listener received bad JSON");
        return;
      }
      if (!parsed) {
        return;
      }

      if (parsed.kind === "subscription") {
        if (parsed.id === subscribeRequestId) {
          subscriptionId = parsed.result;
        }
        return;
      }

      if (parsed.value.err) {
        return;
      }

      const dataLogs = logLinesToEvents(parsed.value.logs);
      for (const data of dataLogs) {
        const decoded = decodeEventBytes(data);
        if (!decoded) {
          if (!isKnownEventSize(data.length)) {
            if (!seenUnknownEventSizes.has(data.length)) {
              seenUnknownEventSizes.add(data.length);
              fastify.log.warn(
                { size: data.length },
                "Solana listener received unknown event size"
              );
            }
          }
          continue;
        }

        void queue.push(async () => {
          try {
            if (decoded.type === "outbound") {
              await handleOutboundEvent(decoded.event);
            } else if (decoded.type === "override-outbound") {
              await handleOverrideOutboundEvent(decoded.event);
            }
          } catch (error) {
            fastify.log.error(
              { err: error },
              "Solana listener failed to process event"
            );
          }
        });
      }
    };

    const onOpen = () => {
      subscribeRequestId = sendRequest("logsSubscribe", [
        { mentions: [QS_BRIDGE_PROGRAM_ADDRESS] },
        { commitment: "confirmed" },
      ]);
    };

    const onError = (event: { data?: unknown }) => {
      fastify.log.error({ event }, "Solana listener WebSocket error");
    };

    const onClose = () => {
      subscriptionId = null;
    };

    fastify.addHook("onReady", async () => {
      const instance = fastify as FastifyInstance & {
        solanaWsFactory?: WebSocketFactory;
        parent?: FastifyInstance & { solanaWsFactory?: WebSocketFactory };
      };
      const wsFactory = resolveSolanaWsFactory(
        instance,
        createDefaultSolanaWsFactory()
      );
      ws = wsFactory(config.SOLANA_WS_URL);
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });

    fastify.addHook("onClose", async () => {
      if (!ws) {
        return;
      }
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);

      if (subscriptionId !== null && ws.readyState === WebSocket.OPEN) {
        sendRequest("logsUnsubscribe", [subscriptionId]);
      }

      ws.close();
      ws = null;
    });
  },
  {
    name: "ws-solana-listener",
    dependencies: ["env", "signer-service", "orders-repository"],
  }
);
