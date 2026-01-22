import process from "node:process";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getSignatureFromTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOraclePda } from "../dist/clients/js/pdas/oracle.js";
import { getAddOracleInstruction } from "../dist/clients/js/instructions/addOracle.js";
import {
  createRpcClients,
  applyComputeBudget,
  readKeypairBytes,
  resolveRpcUrl,
  resolveWsUrl,
} from "./utils.js";

const DEFAULT_ADMIN_KEYPAIR = "./.temp/solana-admin.json";

async function main() {
  const oraclePubkeyRaw = process.argv[2];
  const adminKeyPath = process.argv[3] || DEFAULT_ADMIN_KEYPAIR;
  if (!oraclePubkeyRaw) {
    throw new Error(
      "Usage: node scripts/add-oracle.js <oraclePubkey> [adminKeyPath]"
    );
  }

  const rpcUrl = resolveRpcUrl();
  const wsUrl = resolveWsUrl();

  const adminBytes = await readKeypairBytes(
    adminKeyPath,
    "Admin keypair file"
  );
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

  const { rpc, sendAndConfirmTransaction } = createRpcClients(rpcUrl, wsUrl);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = applyComputeBudget(
    appendTransactionMessageInstruction(
      instruction,
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayer(
          adminSigner.address,
          createTransactionMessage({ version: "legacy" })
        )
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
