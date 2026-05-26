import fp from "fastify-plugin";
import { Buffer } from "node:buffer";
import { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import {
  kQubicContractClient,
  type QubicContractClient,
  FUNC_GET_LOCKED_ORDER,
  FUNC_IS_ORDER_FILLED,
  encodeGetLockedOrderInput,
  decodeGetLockedOrder,
} from "../../../infra/qubic-contract-client.js";
import { Network } from "../../common/schemas/common.js";
import {
  type QubicStoredEvent,
  type QubicLockEventPayload,
} from "./schemas/qubic-event.js";

export interface QubicEventValidator {
  validate(event: QubicStoredEvent): Promise<void>;
}

export const kQubicEventValidator = Symbol("app.qubicEventValidator");

type Logger = FastifyBaseLogger;

export function createQubicEventValidator(deps: {
  contractClient: QubicContractClient;
  logger: Logger;
}): QubicEventValidator {
  const { contractClient, logger } = deps;

  return {
    async validate(event: QubicStoredEvent) {
      if (event.type === "unlock") {
        let hex: string;
        try {
          hex = await contractClient.queryContractFunction(
            FUNC_IS_ORDER_FILLED,
            event.signature,
          );
        } catch (error) {
          logger.warn({ err: error }, "Qubic contract query failed");
          throw error;
        }

        const filled = Buffer.from(hex, "hex")[0] !== 0;
        if (!filled) {
          throw new Error("Order not filled");
        }
        return;
      }

      const nonce = Number(event.nonce);
      let hex: string;
      try {
        hex = await contractClient.queryContractFunction(
          FUNC_GET_LOCKED_ORDER,
          encodeGetLockedOrderInput(nonce),
        );
      } catch (error) {
        logger.warn({ err: error }, "Qubic contract query failed");
        throw error;
      }

      const order = decodeGetLockedOrder(hex);
      if (order === null) {
        throw new Error("Order not found");
      }

      if (event.type === "lock" || event.type === "override-lock") {
        const payload = event.payload as QubicLockEventPayload;

        if (order.amount !== BigInt(payload.amount)) {
          throw new Error("Order amount mismatch");
        }
        if (order.relayerFee !== BigInt(payload.relayerFee)) {
          throw new Error("Order relayerFee mismatch");
        }
        if (order.networkOut !== Network.Solana) {
          throw new Error("Order networkOut mismatch");
        }
        const actualSenderHex = Buffer.from(order.sender).toString("hex");
        if (actualSenderHex !== payload.fromAddress) {
          throw new Error("Order sender mismatch");
        }
      }
    },
  };
}

export default fp(
  async function qubicEventsValidatorPlugin(fastify: FastifyInstance) {
    if (fastify.hasDecorator(kQubicEventValidator)) {
      return;
    }
    const contractClient =
      fastify.getDecorator<QubicContractClient>(kQubicContractClient);
    const validator = createQubicEventValidator({
      contractClient,
      logger: fastify.log,
    });
    fastify.decorate(kQubicEventValidator, validator);
  },
  {
    name: "qubic-events-validator",
    dependencies: ["qubic-contract-client"],
  },
);
