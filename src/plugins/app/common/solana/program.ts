import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getBytesEncoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  prependTransactionMessageInstructions,
  type Address,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../../clients/js/programs/qsBridge.js";

export { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS };

export const CONTRACT_ADDRESS_BYTES = new Uint8Array(
  getAddressEncoder().encode(address(QS_BRIDGE_PROGRAM_ADDRESS))
);

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function encodeString(value: string): Uint8Array {
  const stringBytes = getUtf8Encoder().encode(value);
  const lengthBytes = getU32Encoder().encode(stringBytes.length);
  return concatBytes([new Uint8Array(lengthBytes), new Uint8Array(stringBytes)]);
}

export type BridgeOrderFields = {
  protocolName: string;
  protocolVersion: string;
  contractAddress: Uint8Array;
  networkIn: number;
  networkOut: number;
  tokenIn: Uint8Array;
  tokenOut: Uint8Array;
  fromAddress: Uint8Array;
  toAddress: Uint8Array;
  amount: bigint;
  relayerFee: bigint;
  nonce: Uint8Array;
  orderEra: number;
};

export function serializeBridgeOrder(order: BridgeOrderFields): Uint8Array {
  return concatBytes([
    encodeString(order.protocolName),
    encodeString(order.protocolVersion),
    new Uint8Array(getBytesEncoder().encode(order.contractAddress)),
    new Uint8Array(getU32Encoder().encode(order.networkIn)),
    new Uint8Array(getU32Encoder().encode(order.networkOut)),
    new Uint8Array(getBytesEncoder().encode(order.tokenIn)),
    new Uint8Array(getBytesEncoder().encode(order.tokenOut)),
    new Uint8Array(getBytesEncoder().encode(order.fromAddress)),
    new Uint8Array(getBytesEncoder().encode(order.toAddress)),
    new Uint8Array(getU64Encoder().encode(order.amount)),
    new Uint8Array(getU64Encoder().encode(order.relayerFee)),
    new Uint8Array(getBytesEncoder().encode(order.nonce)),
    new Uint8Array(getU32Encoder().encode(order.orderEra)),
  ]);
}

export function padToLength<T>(items: T[], length: number, filler: T): T[] {
  if (items.length >= length) return items.slice(0, length);
  return items.concat(Array.from({ length: length - items.length }, () => filler));
}

export async function findAssociatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: Address,
  associatedTokenProgram: Address
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: associatedTokenProgram,
    seeds: [
      encoder.encode(owner),
      encoder.encode(tokenProgram),
      encoder.encode(mint),
    ],
  });
  return ata;
}

export function applyComputeBudget<T extends Parameters<typeof prependTransactionMessageInstructions>[1]>(
  message: T,
  { computeUnitLimit = 300_000, computeUnitPrice = 0n } = {}
) {
  const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");
  const limitData = new Uint8Array(5);
  limitData[0] = 2;
  new DataView(limitData.buffer).setUint32(1, computeUnitLimit, true);
  const priceData = new Uint8Array(9);
  priceData[0] = 3;
  new DataView(priceData.buffer).setBigUint64(1, computeUnitPrice, true);

  return prependTransactionMessageInstructions(
    [
      { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: limitData },
      { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data: priceData },
    ],
    message
  );
}
