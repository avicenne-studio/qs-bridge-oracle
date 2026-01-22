import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { kEnvConfig, type EnvConfig } from "../../infra/env.js";

export type RelayerFeeAcceptance = {
  acceptRelayToSolana: (amount: bigint, relayerFee: bigint) => boolean;
  acceptRelayToQubic: (amount: bigint, relayerFee: bigint) => boolean;
};

export const kRelayerFeeAcceptance = Symbol("app.relayerFeeAcceptance");

const SOLANA_DECIMALS = 6;
const QUBIC_DECIMALS = 8;

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function parsePercentToRatio(value: string, decimals: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  const scale = fraction.length;
  const percentScaled = BigInt(`${whole}${fraction}`);
  const denominator = 100n * pow10(scale);
  return ceilDiv(percentScaled * pow10(decimals), denominator);
}

function minimumRelayerFee(
  amount: bigint,
  ratio: bigint,
  decimals: number
): bigint {
  if (amount < 0n) {
    throw new Error("RelayerFeeAcceptance: amount must be non-negative");
  }
  return ceilDiv(amount * ratio, pow10(decimals));
}

function createRelayerFeeAcceptance(config: EnvConfig): RelayerFeeAcceptance {
  const solanaRatio = parsePercentToRatio(
    config.RELAYER_FEE_PERCENT,
    SOLANA_DECIMALS
  );
  const qubicRatio = parsePercentToRatio(
    config.RELAYER_FEE_PERCENT,
    QUBIC_DECIMALS
  );
  return {
    acceptRelayToSolana(amount, relayerFee) {
      return relayerFee >= minimumRelayerFee(amount, solanaRatio, SOLANA_DECIMALS);
    },
    acceptRelayToQubic(amount, relayerFee) {
      return relayerFee >= minimumRelayerFee(amount, qubicRatio, QUBIC_DECIMALS);
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
