import qubicCryptoModule from "@qubic-lib/qubic-ts-library";

export type QubicCryptoPrimitives = {
  schnorrq: {
    sign: (sk: Uint8Array, pk: Uint8Array, msg: Uint8Array) => Uint8Array;
    verify: (pk: Uint8Array, msg: Uint8Array, sig: Uint8Array) => number;
  };
  K12: (input: Uint8Array, output: Uint8Array, outputLength: number) => void;
};

type QubicCryptoModule = { default: { crypto: Promise<QubicCryptoPrimitives> } };

export function resolveQubicCrypto(): Promise<QubicCryptoPrimitives> {
  return (qubicCryptoModule as unknown as QubicCryptoModule).default.crypto;
}

// Seed from test/fixtures/signer/qubic.keys.json
export const QUBIC_FIXTURE_SEED = "aoftkmcshcjliulcifkpojwhxpmagekmxygsdiqdlwtgkxqsymsyovl";
