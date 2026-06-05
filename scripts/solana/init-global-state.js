import process from "node:process";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getUtf8Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getInitGlobalStateInstruction } from "../../dist/clients/js/instructions/initGlobalState.js";
import { findGlobalStatePda } from "../../dist/clients/js/pdas/globalState.js";
import {
  createRpcClients,
  applyComputeBudget,
  readKeypairBytes,
  resolveRpcUrl,
  resolveWsUrl,
} from "../shared/utils.js";

const METADATA_PROGRAM_ADDRESS = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const DEFAULT_ADMIN_KEYPAIR = "./.temp/solana-admin.json";
const DEFAULT_PROTOCOL_FEE_RECIPIENT_KEYPAIR = "./.temp/recipient.json";

async function main() {
  const adminKeyPath = process.argv[2] || DEFAULT_ADMIN_KEYPAIR;
  const protocolFeeRecipientKeyPath =
    process.argv[3] || DEFAULT_PROTOCOL_FEE_RECIPIENT_KEYPAIR;

  const bpsFee = Number(process.env.SOLANA_BPS_FEE ?? 25);
  const protocolFeeBpsOfBps = Number(process.env.PROTOCOL_FEE_BPS_OF_BPS ?? 0);
  const tokenName = process.env.TOKEN_NAME ?? "Wrapped Qubic";
  const tokenSymbol = process.env.TOKEN_SYMBOL ?? "wQUBIC";
  const tokenUri =
    process.env.TOKEN_URI ??
    "https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw";

  const rpcUrl = resolveRpcUrl();
  const wsUrl = resolveWsUrl();

  const adminBytes = await readKeypairBytes(adminKeyPath, "Admin keypair file");
  const adminSigner = await createKeyPairSignerFromBytes(adminBytes);

  const recipientBytes = await readKeypairBytes(
    protocolFeeRecipientKeyPath,
    "Protocol fee recipient keypair file"
  );
  const recipientSigner = await createKeyPairSignerFromBytes(recipientBytes);

  const tokenMintSigner = await generateKeyPairSigner();

  const [globalStatePda] = await findGlobalStatePda();

  const [tokenMetadataPda] = await getProgramDerivedAddress({
    programAddress: address(METADATA_PROGRAM_ADDRESS),
    seeds: [
      getUtf8Encoder().encode("metadata"),
      getAddressEncoder().encode(address(METADATA_PROGRAM_ADDRESS)),
      getAddressEncoder().encode(tokenMintSigner.address),
    ],
  });

  process.stderr.write(`Admin:                   ${adminSigner.address}\n`);
  process.stderr.write(
    `Protocol fee recipient:  ${recipientSigner.address}\n`
  );
  process.stderr.write(`Token mint (new):        ${tokenMintSigner.address}\n`);
  process.stderr.write(`GlobalState PDA:         ${globalStatePda}\n`);
  process.stderr.write(`Token metadata PDA:      ${tokenMetadataPda}\n`);
  process.stderr.write(
    `Fees: bpsFee=${bpsFee} protocolFeeBpsOfBps=${protocolFeeBpsOfBps}\n`
  );

  const instruction = getInitGlobalStateInstruction({
    admin: adminSigner,
    globalState: globalStatePda,
    protocolFeeRecipient: recipientSigner.address,
    tokenMint: tokenMintSigner,
    tokenMetadata: tokenMetadataPda,
    bpsFee,
    protocolFeeBpsOfBps,
    name: tokenName,
    symbol: tokenSymbol,
    uri: tokenUri,
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

  try {
    await sendAndConfirmTransaction(signedTransaction, {
      commitment: "confirmed",
    });
  } catch (error) {
    process.stderr.write(`Transaction failed: ${error?.message || error}\n`);
    const ctx = error?.context ?? error?.cause?.context;
    if (ctx?.logs?.length) {
      process.stderr.write(`Program logs:\n${ctx.logs.join("\n")}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(
    `GlobalState initialized. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n\n` +
      `Add to .env.local:\n` +
      `TOKEN_MINT=${tokenMintSigner.address}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
