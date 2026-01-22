import { Buffer } from "node:buffer";
import process from "node:process";
import {
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOutboundOrderPda } from "../dist/clients/js/pdas/outboundOrder.js";
import { getOutboundInstruction } from "../dist/clients/js/instructions/outbound.js";
import { fetchGlobalState } from "../dist/clients/js/accounts/globalState.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  createRpcClients,
  applyComputeBudget,
  findAssociatedTokenAddress,
  logSection,
  parseHexBytes32,
  parseKeypairBytes,
  readJson,
  resolveRpcUrl,
  resolveWsUrl,
} from "./utils.js";

async function main() {
  const orderPath = process.argv[2];
  const userKeyPath = process.argv[3];
  if (!orderPath || !userKeyPath) {
    throw new Error(
      "Usage: node scripts/send-outbound-order.js <outbound-order.json> <user-key.json>"
    );
  }

  const rpcUrl = resolveRpcUrl();
  const wsUrl = resolveWsUrl();

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

  const { rpc, sendAndConfirmTransaction } = createRpcClients(rpcUrl, wsUrl);

  const [globalStatePda] = await findGlobalStatePda();
  const globalState = await fetchGlobalState(rpc, globalStatePda);
  const tokenMint = globalState.data.tokenMint;

  logSection("send-outbound-order", "Inputs");
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
  logSection("send-outbound-order", "Outbound order PDA");
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
  const message = applyComputeBudget(
    appendTransactionMessageInstruction(
      instruction,
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayer(
          userSigner.address,
          createTransactionMessage({ version: "legacy" })
        )
      )
    )
  );

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTransaction);

  logSection("send-outbound-order", "Transaction");
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
