import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOutboundOrderPda } from "../dist/clients/js/pdas/outboundOrder.js";
import { getOutboundInstruction } from "../dist/clients/js/instructions/outbound.js";
import { fetchGlobalState } from "../dist/clients/js/accounts/globalState.js";

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_WS_URL = "wss://api.devnet.solana.com";
const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

function parseKeypairBytes(value, label) {
  if (!Array.isArray(value) || value.length !== 64) {
    throw new Error(`${label} must be a JSON array of 64 bytes`);
  }
  return new Uint8Array(value);
}

function parseHexBytes32(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a hex string`);
  }
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length !== 64 || !HEX_PATTERN.test(normalized)) {
    throw new Error(`${field} must be 32-byte hex (0x...)`);
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

async function findAssociatedTokenAddress(
  owner,
  mint,
  tokenProgram,
  associatedTokenProgram
) {
  const [ata] = await getProgramDerivedAddress({
    programAddress: associatedTokenProgram,
    seeds: [
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(tokenProgram),
      getAddressEncoder().encode(mint),
    ],
  });
  return ata;
}

function logSection(title) {
  process.stdout.write(`\n[send-outbound-order] ${title}\n`);
}

async function main() {
  const orderPath = process.argv[2];
  const userKeyPath = process.argv[3];
  if (!orderPath || !userKeyPath) {
    throw new Error(
      "Usage: node scripts/send-outbound-order.js <outbound-order.json> <user-key.json>"
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const wsUrl = process.env.SOLANA_WS_URL || DEFAULT_WS_URL;

  const order = await readJson(orderPath);
  const userKey = await readJson(userKeyPath);
  const userSigner = await createKeyPairSignerFromBytes(
    parseKeypairBytes(userKey, "User keypair")
  );

  const networkOut = Number(order.networkOut);
  const tokenOut = parseHexBytes32(order.tokenOut, "tokenOut");
  const toAddress = parseHexBytes32(order.toAddress, "toAddress");
  const amount = BigInt(order.amount);
  const relayerFee = BigInt(order.relayerFee);
  const nonce = parseHexBytes32(order.nonce, "nonce");

  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  const [globalStatePda] = await findGlobalStatePda();
  const globalState = await fetchGlobalState(rpc, globalStatePda);
  const tokenMint = globalState.data.tokenMint;

  logSection("Inputs");
  process.stdout.write(
    JSON.stringify(
      {
        orderPath,
        userKeyPath,
        user: userSigner.address,
        tokenMint,
        networkOut,
        amount: amount.toString(),
        relayerFee: relayerFee.toString(),
        nonce: Buffer.from(nonce).toString("hex"),
      },
      null,
      2
    ) + "\n"
  );

  const userTokenAccount = await findAssociatedTokenAddress(
    userSigner.address,
    tokenMint,
    TOKEN_PROGRAM_ADDRESS,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS
  );
  const userAccount = await rpc
    .getAccountInfo(userSigner.address, { encoding: "base64" })
    .send();
  if (!userAccount?.value) {
    throw new Error(
      `User account not found. Fund ${userSigner.address} with devnet SOL.`
    );
  }
  const userTokenInfo = await rpc
    .getAccountInfo(userTokenAccount, { encoding: "base64" })
    .send();
  if (!userTokenInfo?.value) {
    throw new Error(
      `User token account missing: ${userTokenAccount}. Ensure inbound mint was received.`
    );
  }

  const [outboundOrderPda] = await findOutboundOrderPda({ networkOut, nonce });
  logSection("Outbound order PDA");
  process.stdout.write(`outboundOrderPda: ${outboundOrderPda}\n`);

  const instruction = getOutboundInstruction({
    user: userSigner,
    globalState: globalStatePda,
    outboundOrder: outboundOrderPda,
    userTokenAccount,
    tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    networkOut,
    tokenOut,
    toAddress,
    amount,
    relayerFee,
    nonce,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = appendTransactionMessageInstruction(
    instruction,
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayer(
        userSigner.address,
        createTransactionMessage({ version: "legacy" })
      )
    )
  );

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTransaction);

  logSection("Transaction");
  process.stdout.write(`signature: ${signature}\n`);

  if (typeof rpc.simulateTransaction === "function") {
    const encoded = getBase64EncodedWireTransaction(signedTransaction);
    const simulation = await rpc
      .simulateTransaction(encoded, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
      .send();
    if (simulation?.value?.err) {
      process.stderr.write(
        `Simulation error: ${JSON.stringify(
          simulation.value.err,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value)
        )}\n`
      );
      if (simulation.value.logs?.length) {
        process.stderr.write(
          `Simulation logs:\n${simulation.value.logs.join("\n")}\n`
        );
      }
      return;
    }
  }

  await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });

  process.stdout.write(
    `Outbound order sent. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
