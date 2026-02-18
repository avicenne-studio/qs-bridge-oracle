import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
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
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { PublicKey, Connection } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import type { EnvConfig } from "../../infra/env.js";
import type { OrdersRepository } from "../indexer/orders.repository.js";
import type { OracleOrder } from "../indexer/schemas/order.js";
import { Network } from "../common/schemas/common.js";
import { hexToBytes } from "../events/solana/bytes.js";
import { decodeSecretKey } from "../signer/signer.service.js";
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
import { getOracleSize } from "../../../clients/js/accounts/oracle.js";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  QUBIC_TOKEN_ADDRESS,
  CONTRACT_ADDRESS_BYTES,
  serializeBridgeOrder,
  padToLength,
  findAssociatedTokenAddress,
  applyComputeBudget,
  TOKEN_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
} from "../common/solana-helpers.js";

export type SolanaRelayDeps = {
  config: EnvConfig;
  relayerSigner: KeyPairSigner;
  connection: Connection;
  rpc: ReturnType<typeof createSolanaRpc>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
  ordersRepository: OrdersRepository;
  logger: FastifyInstance["log"];
};

const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(
  message: Uint8Array,
  signature: Uint8Array,
  publicKeyRaw: Uint8Array
): boolean {
  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_DER_PREFIX, publicKeyRaw]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(null, message, keyObject, signature);
}

async function fetchOracleAddresses(
  connection: Connection
): Promise<Address[]> {
  const accounts = await connection.getProgramAccounts(
    new PublicKey(QS_BRIDGE_PROGRAM_ADDRESS),
    {
      filters: [
        { dataSize: getOracleSize() },
        { memcmp: { offset: 0, bytes: "2" } },
      ],
    }
  );
  return accounts.map(({ account }) => {
    const pubkeyBytes = account.data.slice(1, 33);
    return new PublicKey(pubkeyBytes).toBase58() as Address;
  });
}

function matchSignaturesToOracles(
  signatures: Uint8Array[],
  oracleAddresses: Address[],
  digest: Uint8Array
): { matched: Array<{ oracle: Address; signature: Uint8Array }> } {
  const matched: Array<{ oracle: Address; signature: Uint8Array }> = [];
  const usedOracles = new Set<string>();

  for (const sig of signatures) {
    for (const oracle of oracleAddresses) {
      if (usedOracles.has(oracle)) continue;
      const pubkeyBytes = new PublicKey(oracle).toBytes();
      if (verifyEd25519(digest, sig, pubkeyBytes)) {
        matched.push({ oracle, signature: sig });
        usedOracles.add(oracle);
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
  const { config, relayerSigner, connection, rpc, sendAndConfirm, ordersRepository, logger } = deps;

  const tokenMintBytes = new PublicKey(config.TOKEN_MINT).toBytes();
  const networkIn = Network.Qubic;
  const networkOut = Network.Solana;
  const fromAddress = hexToBytes(order.from);
  const toAddress = hexToBytes(order.to);
  const amount = BigInt(order.amount);
  const relayerFee = BigInt(order.relayerFee);
  const nonce = hexToBytes(order.source_nonce);

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

  const storedSignatures = await ordersRepository.getSignatures(order.id);
  if (storedSignatures.length === 0) {
    throw new Error("No oracle signatures found for order");
  }

  const rawSignatures = storedSignatures.map(
    (s) => new Uint8Array(Buffer.from(s, "base64"))
  );

  const oracleAddresses = await fetchOracleAddresses(connection);
  if (oracleAddresses.length === 0) {
    throw new Error("No registered oracles found on chain");
  }

  const { matched } = matchSignaturesToOracles(
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

  const oraclePdas = await Promise.all(
    matched.map(async ({ oracle }) => {
      const [pda] = await findOraclePda({ oracle });
      return pda;
    })
  );
  const paddedOraclePdas = padToLength(oraclePdas, 6, oraclePdas[0]);
  const orderedSignatures = matched.map(({ signature }) => signature);

  const recipient = new PublicKey(Buffer.from(toAddress)).toBase58() as Address;
  const tokenMint = address(config.TOKEN_MINT);
  const [globalStatePda] = await findGlobalStatePda();
  const [inboundOrderPda] = await findInboundOrderPda({ networkIn, nonce });

  const recipientAta = await findAssociatedTokenAddress(recipient, tokenMint, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  const relayerAta = await findAssociatedTokenAddress(relayerSigner.address, tokenMint, TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS);

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

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const baseMessage = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash,
    setTransactionMessageFeePayer(
      relayerSigner.address,
      createTransactionMessage({ version: "legacy" })
    )
  );
  const withInstruction = appendTransactionMessageInstruction(instruction, baseMessage);
  const finalMessage = applyComputeBudget(withInstruction);

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

  const connection = new Connection(config.SOLANA_RPC_URL, config.SOLANA_TX_COMMITMENT);
  const rpc = createSolanaRpc(config.SOLANA_RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    config.SOLANA_RPC_URL.replace(/^http/, "ws")
  );
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  return {
    config,
    relayerSigner,
    connection,
    rpc,
    sendAndConfirm,
    ordersRepository,
    logger: fastify.log,
  };
}
