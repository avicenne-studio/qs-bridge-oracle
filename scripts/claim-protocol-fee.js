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
import { getClaimProtocolFeeInstruction } from "../dist/clients/js/instructions/claimProtocolFee.js";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { fetchGlobalState } from "../dist/clients/js/accounts/globalState.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  createRpcClients,
  applyComputeBudget,
  findAssociatedTokenAddress,
  readKeypairBytes,
  resolveRpcUrl,
  resolveWsUrl,
} from "./utils.js";

async function main() {
  const protocolFeeRecipientKeyPath = process.argv[2];
  if (!protocolFeeRecipientKeyPath) {
    throw new Error(
      "Usage: node scripts/claim-protocol-fee.js <protocolFeeRecipientKey.json>"
    );
  }

  const rpcUrl = resolveRpcUrl();
  const wsUrl = resolveWsUrl();

  const recipientBytes = await readKeypairBytes(
    protocolFeeRecipientKeyPath,
    "Protocol fee recipient keypair file"
  );
  const recipientSigner = await createKeyPairSignerFromBytes(recipientBytes);

  const { rpc, sendAndConfirmTransaction } = createRpcClients(rpcUrl, wsUrl);

  const [globalStatePda] = await findGlobalStatePda();
  const globalState = await fetchGlobalState(rpc, globalStatePda);
  const tokenMint = globalState.data.tokenMint;

  if (globalState.data.protocolFeeRecipient !== recipientSigner.address) {
    throw new Error(
      `Signer ${recipientSigner.address} is not protocolFeeRecipient ${globalState.data.protocolFeeRecipient}`
    );
  }

  const tokenProgram = address(TOKEN_PROGRAM_ADDRESS);
  const associatedTokenProgram = address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  const protocolFeeRecipientAta = await findAssociatedTokenAddress(
    recipientSigner.address,
    tokenMint,
    tokenProgram,
    associatedTokenProgram
  );

  const instruction = getClaimProtocolFeeInstruction({
    protocolFeeRecipient: recipientSigner,
    globalState: globalStatePda,
    tokenMint,
    protocolFeeRecipientAta,
    tokenProgram,
    associatedTokenProgram,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = applyComputeBudget(
    appendTransactionMessageInstruction(
      instruction,
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayer(
          recipientSigner.address,
          createTransactionMessage({ version: "legacy" })
        )
      )
    )
  );

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTransaction);

  await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });

  process.stdout.write(
    `Protocol fee claimed. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
