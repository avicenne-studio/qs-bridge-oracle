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
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getClaimOracleFeeInstruction } from "../dist/clients/js/instructions/claimOracleFee.js";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOraclePda } from "../dist/clients/js/pdas/oracle.js";
import { fetchGlobalState } from "../dist/clients/js/accounts/globalState.js";
import { fetchOracle } from "../dist/clients/js/accounts/oracle.js";

const DEFAULT_ADMIN_KEYPAIR = "./test/fixtures/solana-admin.json";
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

async function main() {
  const oraclePubkeyRaw = process.argv[2];
  const adminKeyPath = process.argv[3] || DEFAULT_ADMIN_KEYPAIR;
  if (!oraclePubkeyRaw) {
    throw new Error(
      "Usage: node scripts/claim-oracle-fee.js <oraclePubkey> [adminKeyPath]"
    );
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const wsUrl = process.env.SOLANA_WS_URL || DEFAULT_WS_URL;

  const adminBytes = await readKeypairBytes(adminKeyPath);
  const adminSigner = await createKeyPairSignerFromBytes(adminBytes);
  const oracleOwner = address(oraclePubkeyRaw);

  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  const [globalStatePda] = await findGlobalStatePda();
  const globalState = await fetchGlobalState(rpc, globalStatePda);
  const tokenMint = globalState.data.tokenMint;

  const [oraclePda] = await findOraclePda({ oracle: oracleOwner });
  const oracleAccount = await fetchOracle(rpc, oraclePda);

  if (globalState.data.admin !== adminSigner.address) {
    throw new Error(
      `Admin key does not match globalState admin: ${globalState.data.admin}`
    );
  }
  if (oracleAccount.data.claimableBalance === 0n) {
    process.stdout.write("Oracle claimable balance is 0. Nothing to claim.\n");
    return;
  }

  const tokenProgram = address(TOKEN_PROGRAM_ADDRESS);
  const associatedTokenProgram = address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  const oracleAta = await findAssociatedTokenAddress(
    oracleOwner,
    tokenMint,
    tokenProgram,
    associatedTokenProgram
  );

  const instruction = getClaimOracleFeeInstruction({
    claimer: adminSigner,
    globalState: globalStatePda,
    oraclePda,
    oracleOwner,
    tokenMint,
    oracleAta,
    tokenProgram,
    associatedTokenProgram,
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

  process.stdout.write(
    `Oracle fee claimed. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
