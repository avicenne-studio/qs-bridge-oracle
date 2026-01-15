import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOraclePda } from "../dist/clients/js/pdas/oracle.js";
import { getRemoveOracleInstruction } from "../dist/clients/js/instructions/removeOracle.js";

const DEFAULT_ADMIN_KEYPAIR = "./test/fixtures/solana-admin.json";
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_WS_URL = "wss://api.devnet.solana.com";

async function readKeypairBytes(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("Admin keypair file must be a JSON array of 64 bytes");
  }
  return new Uint8Array(parsed);
}

async function waitForRemoval(rpc, oraclePda, retries) {
  for (let i = 0; i < retries; i += 1) {
    const account = await rpc
      .getAccountInfo(oraclePda, { encoding: "base64" })
      .send();
    if (!account?.value) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const oraclePubkeyRaw = process.argv[2];
  const adminKeyPath = process.argv[3] || DEFAULT_ADMIN_KEYPAIR;
  if (!oraclePubkeyRaw) {
    throw new Error(
      "Usage: node scripts/delete-oracle.js <oraclePubkey> [adminKeyPath]"
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const wsUrl = process.env.SOLANA_WS_URL || DEFAULT_WS_URL;

  const adminBytes = await readKeypairBytes(adminKeyPath);
  const adminSigner = await createKeyPairSignerFromBytes(adminBytes);
  const oracleAddress = address(oraclePubkeyRaw);

  const [globalStatePda] = await findGlobalStatePda();
  const [oraclePda] = await findOraclePda({ oracle: oracleAddress });

  const rpc = createSolanaRpc(rpcUrl);
  const existing = await rpc
    .getAccountInfo(oraclePda, { encoding: "base64" })
    .send();
  if (!existing?.value) {
    process.stdout.write("Oracle already removed.\n");
    return;
  }

  const instruction = getRemoveOracleInstruction({
    admin: adminSigner,
    globalState: globalStatePda,
    oraclePda,
  });

  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = appendTransactionMessageInstruction(
    instruction,
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayer(
        adminSigner.address,
        createTransactionMessage({ version: "legacy" })
      )
    )
  );

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTransaction);

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

  const removed = await waitForRemoval(rpc, oraclePda, 10);
  process.stdout.write(
    `Oracle removal tx: ${signature}\n` +
      `Removed: ${removed ? "yes" : "pending"}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
