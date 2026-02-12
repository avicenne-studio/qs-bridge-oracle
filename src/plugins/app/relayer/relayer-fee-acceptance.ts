import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";

export type RelayerFeeAcceptance = {
  acceptRelayToSolana: (amount: bigint, relayerFee: bigint) => boolean;
  acceptRelayToQubic: (amount: bigint, relayerFee: bigint) => boolean;
};

export const kRelayerFeeAcceptance = Symbol("app.relayerFeeAcceptance");

const DECIMAL_PATTERN = /^[0-9]+$/;

function parseRelayerFee(value: string, label: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`RelayerFeeAcceptance: ${label} must be an integer string`);
  }
  return BigInt(value);
}

function createRelayerFeeAcceptance(config: EnvConfig): RelayerFeeAcceptance {
  const solanaFee = parseRelayerFee(
    config.RELAYER_FEE_SOLANA,
    "RELAYER_FEE_SOLANA"
  );
  const qubicFee = parseRelayerFee(
    config.RELAYER_FEE_QUBIC,
    "RELAYER_FEE_QUBIC"
  );
  return {
    acceptRelayToSolana(amount, relayerFee) {
      if (amount < 0n) {
        throw new Error("RelayerFeeAcceptance: amount must be non-negative");
      }
      return relayerFee >= solanaFee;
    },
    acceptRelayToQubic(amount, relayerFee) {
      if (amount < 0n) {
        throw new Error("RelayerFeeAcceptance: amount must be non-negative");
      }
      return relayerFee >= qubicFee;
    },
  };
}

export default fp(
  async function relayerFeeAcceptancePlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<EnvConfig>(kEnvConfig);
    fastify.decorate(kRelayerFeeAcceptance, createRelayerFeeAcceptance(config));
  },
  { name: "relayerFeeAcceptance", dependencies: ["env"] }
);
