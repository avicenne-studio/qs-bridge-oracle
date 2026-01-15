import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getClaimProtocolFeeInstruction } from "../dist/clients/js/instructions/claimProtocolFee.js";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { fetchGlobalState } from "../dist/clients/js/accounts/globalState.js";

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_WS_URL = "wss://api.devnet.solana.com";
const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

async function readKeypairBytes(filePath) {
  const raw = await readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error("Keypair file must be a JSON array of 64 bytes");
  }
  return new Uint8Array(parsed);
}

async function findAssociatedTokenAddress(owner, mint, tokenProgram, associatedTokenProgram) {
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

async function main() {
  const protocolFeeRecipientKeyPath = process.argv[2];
  if (!protocolFeeRecipientKeyPath) {
    throw new Error(
      "Usage: node scripts/claim-protocol-fee.js <protocolFeeRecipientKey.json>"
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const wsUrl = process.env.SOLANA_WS_URL || DEFAULT_WS_URL;

  const recipientBytes = await readKeypairBytes(protocolFeeRecipientKeyPath);
  const recipientSigner = await createKeyPairSignerFromBytes(recipientBytes);

  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

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

  const message = appendTransactionMessageInstruction(
    instruction,
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayer(
        recipientSigner.address,
        createTransactionMessage({ version: "legacy" })
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
