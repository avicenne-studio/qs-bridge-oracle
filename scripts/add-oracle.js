import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOraclePda } from "../dist/clients/js/pdas/oracle.js";
import { getAddOracleInstruction } from "../dist/clients/js/instructions/addOracle.js";

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

async function main() {
  const oraclePubkeyRaw = process.argv[2];
  const adminKeyPath = process.argv[3] || DEFAULT_ADMIN_KEYPAIR;
  if (!oraclePubkeyRaw) {
    throw new Error(
      "Usage: node scripts/add-oracle.js <oraclePubkey> [adminKeyPath]"
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const wsUrl = process.env.SOLANA_WS_URL || DEFAULT_WS_URL;

  const adminBytes = await readKeypairBytes(adminKeyPath);
  const adminSigner = await createKeyPairSignerFromBytes(adminBytes);
  const oracleAddress = address(oraclePubkeyRaw);

  const [globalStatePda] = await findGlobalStatePda();
  const [oraclePda] = await findOraclePda({ oracle: oracleAddress });

  const instruction = getAddOracleInstruction({
    admin: adminSigner,
    globalState: globalStatePda,
    oraclePda,
    oraclePubkey: oracleAddress,
  });

  const rpc = createSolanaRpc(rpcUrl);
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

  await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });

  process.stdout.write(
    `Oracle added. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
