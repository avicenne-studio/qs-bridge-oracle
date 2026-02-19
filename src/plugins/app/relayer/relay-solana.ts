import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  sendAndConfirmTransactionFactory,
  createTransactionMessage,
  appendTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  getAddressEncoder,
  getAddressDecoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import type { Base58EncodedBytes } from "@solana/rpc-types";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import type { FastifyInstance } from "fastify";
import type { EnvConfig } from "../../infra/env.js";
import type { OrdersRepository } from "../indexer/orders.repository.js";
import type { OracleOrder } from "../indexer/schemas/order.js";
import { Network } from "../common/schemas/common.js";
import { solanaAddressToBytes, nonceToBytes, decodeSecretKey } from "../common/bytes.js";
import { qubicAddressToBytes } from "../common/qubic/encoding.js";
import { type SignerKeys, SignerKeysSchema } from "../signer/schemas/keys.js";
import type { FileManager } from "../../infra/@file-manager.js";
import { kFileManager } from "../../infra/@file-manager.js";
import type { ValidationService } from "../common/validation.js";
import { kValidation } from "../common/validation.js";
import { findGlobalStatePda } from "../../../clients/js/pdas/globalState.js";
import { findOraclePda } from "../../../clients/js/pdas/oracle.js";
import { findInboundOrderPda } from "../../../clients/js/pdas/inboundOrder.js";
import { getInboundInstruction } from "../../../clients/js/instructions/inbound.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../../clients/js/programs/qsBridge.js";
import { getOracleSize, getOracleDecoder } from "../../../clients/js/accounts/oracle.js";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "../common/protocol.js";
import { QUBIC_TOKEN_ADDRESS } from "../common/qubic/encoding.js";
import {
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
  padToLength,
  findAssociatedTokenAddress,
  applyComputeBudget,
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
} from "../common/solana/program.js";

export type AddressLookupTable = Record<Address, Address[]>;

export type SolanaRelayDeps = {
  config: EnvConfig;
  relayerSigner: KeyPairSigner;
  rpc: ReturnType<typeof createSolanaRpc>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
  ordersRepository: OrdersRepository;
  logger: FastifyInstance["log"];
  getLookupTable: () => Promise<AddressLookupTable>;
  getOracleAddresses: () => Promise<Address[]>;
};

/** Key.Oracle = 1 -> base58(0x01) = "2" */
const ORACLE_DISCRIMINATOR_B58 = "2" as Base58EncodedBytes;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

const cryptoKeyCache = new Map<string, CryptoKey>();

async function importEd25519PublicKey(publicKeyRaw: Uint8Array): Promise<CryptoKey> {
  const hex = Buffer.from(publicKeyRaw).toString("hex");
  let key = cryptoKeyCache.get(hex);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw", new Uint8Array(publicKeyRaw) as Uint8Array<ArrayBuffer>,
      "Ed25519", true, ["verify"],
    );
    cryptoKeyCache.set(hex, key);
  }
  return key;
}

export async function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  const key = await importEd25519PublicKey(publicKeyRaw);
  return crypto.subtle.verify(
    "Ed25519", key,
    new Uint8Array(signature) as Uint8Array<ArrayBuffer>,
    new Uint8Array(message) as Uint8Array<ArrayBuffer>,
  );
}

export async function fetchOracleAddresses(
  rpc: ReturnType<typeof createSolanaRpc>
): Promise<Address[]> {
  const accounts = await rpc
    .getProgramAccounts(QS_BRIDGE_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getOracleSize()) },
        { memcmp: { offset: 0n, bytes: ORACLE_DISCRIMINATOR_B58, encoding: "base58" } },
      ],
    })
    .send();

  const decoder = getOracleDecoder();
  return accounts.map((entry) => {
    const data = new Uint8Array(Buffer.from(entry.account.data[0], "base64"));
    return decoder.decode(data).oraclePubkey;
  });
}

export async function estimatePriorityFee(
  rpc: ReturnType<typeof createSolanaRpc>,
  accounts: Address[],
  maxFee: number,
): Promise<bigint> {
  const result = await rpc.getRecentPrioritizationFees(accounts).send();
  if (result.length === 0) return 0n;

  const fees = result
    .map((entry) => Number(entry.prioritizationFee))
    .filter((f) => f > 0)
    .sort((a, b) => a - b);

  if (fees.length === 0) return 0n;

  const median = fees[Math.floor(fees.length / 2)];
  return BigInt(Math.min(median, maxFee));
}

export async function matchSignaturesToOracles(
  signatures: Uint8Array[],
  oracleAddresses: Address[],
  digest: Uint8Array
): Promise<{ matched: Array<{ oracle: Address; signature: Uint8Array }> }> {
  const matched: Array<{ oracle: Address; signature: Uint8Array }> = [];
  const usedOracles = new Set<string>();

  const oracleKeys = oracleAddresses.map((addr) => ({
    addr,
    bytes: new Uint8Array(addressEncoder.encode(addr)),
  }));

  for (const sig of signatures) {
    for (const { addr, bytes } of oracleKeys) {
      if (usedOracles.has(addr)) continue;
      if (await verifyEd25519(digest, sig, bytes)) {
        matched.push({ oracle: addr, signature: sig });
        usedOracles.add(addr);
        break;
      }
    }
  }

  return { matched };
}

export async function relayToSolana(
  order: OracleOrder,
  deps: SolanaRelayDeps
): Promise<{ trxHash: string }> {
  const { config, relayerSigner, rpc, sendAndConfirm, ordersRepository, logger, getLookupTable, getOracleAddresses } = deps;

  const tokenMintBytes = new Uint8Array(addressEncoder.encode(address(config.TOKEN_MINT)));
  const networkIn = Network.Qubic;
  const networkOut = Network.Solana;
  const fromAddress = qubicAddressToBytes(order.from);
  const toAddress = solanaAddressToBytes(order.to);
  const amount = BigInt(order.amount);
  const relayerFee = BigInt(order.relayerFee);
  const nonce = nonceToBytes(order.source_nonce);

  const orderPayload = {
    networkIn,
    networkOut,
    tokenIn: QUBIC_TOKEN_ADDRESS,
    tokenOut: tokenMintBytes,
    fromAddress,
    toAddress,
    amount,
    relayerFee,
    nonce,
  };

  const serialized = serializeBridgeOrder({
    protocolName: PROTOCOL_NAME,
    protocolVersion: PROTOCOL_VERSION,
    contractAddress: CONTRACT_ADDRESS_BYTES,
    ...orderPayload,
  });
  const digest = createHash("sha256").update(serialized).digest();

  const [storedSignatures, oracleAddresses] = await Promise.all([
    ordersRepository.findSignatures(order.id),
    getOracleAddresses(),
  ]);

  if (storedSignatures.length === 0) {
    throw new Error("No oracle signatures found for order");
  }
  if (oracleAddresses.length === 0) {
    throw new Error("No registered oracles found on chain");
  }

  const rawSignatures = storedSignatures.map(
    (s) => new Uint8Array(Buffer.from(s, "base64"))
  );

  const { matched } = await matchSignaturesToOracles(
    rawSignatures,
    oracleAddresses,
    new Uint8Array(digest)
  );
  if (matched.length === 0) {
    throw new Error("No signatures could be matched to registered oracles");
  }

  logger.info(
    { orderId: order.id, matchedOracles: matched.length, totalSignatures: storedSignatures.length },
    "Matched oracle signatures for Solana relay"
  );

  const orderedSignatures = matched.map(({ signature }) => signature);
  const recipient = addressDecoder.decode(toAddress);
  const tokenMint = address(config.TOKEN_MINT);

  const [oraclePdas, [globalStatePda], [inboundOrderPda], recipientAta, relayerAta] =
    await Promise.all([
      Promise.all(matched.map(async ({ oracle }) => {
        const [pda] = await findOraclePda({ oracle });
        return pda;
      })),
      findGlobalStatePda(),
      findInboundOrderPda({ networkIn, nonce }),
      findAssociatedTokenAddress(recipient, tokenMint, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      findAssociatedTokenAddress(relayerSigner.address, tokenMint, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
    ]);

  const paddedOraclePdas = padToLength(oraclePdas, 6, oraclePdas[0]);

  const instruction = getInboundInstruction({
    relayer: relayerSigner,
    globalState: globalStatePda,
    tokenMint,
    recipient,
    recipientAta,
    relayerAta,
    inboundOrderPda,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    oracle1Pda: paddedOraclePdas[0],
    oracle2Pda: paddedOraclePdas[1],
    oracle3Pda: paddedOraclePdas[2],
    oracle4Pda: paddedOraclePdas[3],
    oracle5Pda: paddedOraclePdas[4],
    oracle6Pda: paddedOraclePdas[5],
    order: {
      networkIn,
      networkOut,
      tokenIn: QUBIC_TOKEN_ADDRESS,
      tokenOut: tokenMintBytes,
      fromAddress,
      toAddress,
      amount,
      relayerFee,
      nonce,
    },
    signatures: orderedSignatures,
  });

  const writable = [globalStatePda, tokenMint, recipientAta, relayerAta, inboundOrderPda];
  const [{ value: latestBlockhash }, computeUnitPrice, lookupTable] = await Promise.all([
    rpc.getLatestBlockhash().send(),
    estimatePriorityFee(rpc, writable, config.SOLANA_MAX_PRIORITY_FEE),
    getLookupTable(),
  ]);

  const baseMessage = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash,
    setTransactionMessageFeePayer(
      relayerSigner.address,
      createTransactionMessage({ version: 0 })
    )
  );
  const withInstruction = appendTransactionMessageInstruction(instruction, baseMessage);
  const withBudget = applyComputeBudget(withInstruction, { computeUnitPrice });
  const finalMessage = compressTransactionMessageUsingAddressLookupTables(withBudget, lookupTable);

  const signedTransaction = await signTransactionMessageWithSigners(finalMessage);
  const trxHash = getSignatureFromTransaction(signedTransaction);

  await sendAndConfirm(
    signedTransaction as Parameters<typeof sendAndConfirm>[0],
    { commitment: config.SOLANA_TX_COMMITMENT }
  );

  logger.info(
    { orderId: order.id, trxHash },
    "Solana inbound transaction confirmed"
  );

  return { trxHash };
}

export async function buildSolanaRelayDeps(
  fastify: FastifyInstance,
  config: EnvConfig,
  ordersRepository: OrdersRepository
): Promise<SolanaRelayDeps> {
  const fileManager = fastify.getDecorator<FileManager>(kFileManager);
  const validation: ValidationService = fastify.getDecorator<ValidationService>(kValidation);

  const raw: unknown = await fileManager.readJsonFile("RelayerSigner", config.SOLANA_KEYS);
  validation.assertValid<SignerKeys>(SignerKeysSchema, raw, "RelayerSigner");
  const keys = raw as SignerKeys;
  const secretKeyBytes = decodeSecretKey(keys.sKey);
  const relayerSigner = await createKeyPairSignerFromBytes(secretKeyBytes);

  const rpc = createSolanaRpc(config.SOLANA_RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(config.SOLANA_WS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  const lutAddr = address(config.SOLANA_LOOKUP_TABLE_ADDRESS);
  let cachedLut: AddressLookupTable | undefined;
  /* c8 ignore next 6 */
  const getLookupTable = async (): Promise<AddressLookupTable> => {
    if (cachedLut) return cachedLut;
    const lutAccount = await fetchAddressLookupTable(rpc, lutAddr);
    cachedLut = { [lutAddr]: lutAccount.data.addresses };
    return cachedLut;
  };

  let cachedOracles: Address[] | undefined;
  /* c8 ignore next 5 */
  const getOracleAddresses = async (): Promise<Address[]> => {
    if (cachedOracles) return cachedOracles;
    cachedOracles = await fetchOracleAddresses(rpc);
    return cachedOracles;
  };

  return {
    config,
    relayerSigner,
    rpc,
    sendAndConfirm,
    ordersRepository,
    logger: fastify.log,
    getLookupTable,
    getOracleAddresses,
  };
}
