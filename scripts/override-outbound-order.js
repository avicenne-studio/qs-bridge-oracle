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
import { getOverrideOutboundInstruction } from "../dist/clients/js/instructions/overrideOutbound.js";
import {
  createRpcClients,
  logSection,
  parseArgs,
  parseHexBytes32,
  readJson,
  readKeypairBytes,
  resolveRpcUrl,
  resolveWsUrl,
} from "./utils.js";

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const orderPath = parsedArgs._[0];
  const userKeyPath = parsedArgs._[1];
  if (!orderPath || !userKeyPath) {
    throw new Error(
      "Usage: node scripts/override-outbound-order.js <outbound-order.json> <user-key.json> [--to-address <hex>] [--relayer-fee <number>]"
    );
  }

  const overrideToAddress = parsedArgs.toAddress;
  const overrideRelayerFee = parsedArgs.relayerFee;
  if (!overrideToAddress && !overrideRelayerFee) {
    throw new Error("Provide --to-address and/or --relayer-fee to override.");
  }

  const rpcUrl = resolveRpcUrl();
  const wsUrl = resolveWsUrl();

  const order = await readJson(orderPath);
  const userSigner = await createKeyPairSignerFromBytes(
    await readKeypairBytes(userKeyPath, "User keypair")
  );

  const networkOut = Number(order.networkOut);
  const nonce = parseHexBytes32(order.nonce, "nonce");
  const toAddress = overrideToAddress
    ? parseHexBytes32(overrideToAddress, "toAddress")
    : null;
  const relayerFee = overrideRelayerFee ? BigInt(overrideRelayerFee) : null;

  const { rpc, sendAndConfirmTransaction } = createRpcClients(rpcUrl, wsUrl);

  const [globalStatePda] = await findGlobalStatePda();
  const [outboundOrderPda] = await findOutboundOrderPda({ networkOut, nonce });

  logSection("override-outbound-order", "Inputs");
  process.stdout.write(
    JSON.stringify(
      {
        orderPath,
        userKeyPath,
        user: userSigner.address,
        networkOut,
        nonce: Buffer.from(nonce).toString("hex"),
        toAddress: toAddress ? Buffer.from(toAddress).toString("hex") : null,
        relayerFee: relayerFee?.toString() ?? null,
        outboundOrderPda,
      },
      null,
      2
    ) + "\n"
  );

  const instruction = getOverrideOutboundInstruction({
    caller: userSigner,
    globalState: globalStatePda,
    outboundOrder: outboundOrderPda,
    toAddress,
    relayerFee,
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

  logSection("override-outbound-order", "Transaction");
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
    `Outbound order override sent. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
