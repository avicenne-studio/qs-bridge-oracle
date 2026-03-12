import { Buffer } from "node:buffer";
import process from "node:process";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getSignatureFromTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { findGlobalStatePda } from "../../dist/clients/js/pdas/globalState.js";
import { findOraclePda } from "../../dist/clients/js/pdas/oracle.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../../dist/clients/js/programs/qsBridge.js";
import { getOracleSize, getOracleDecoder } from "../../dist/clients/js/accounts/oracle.js";
import {
  createRpcClients,
  applyComputeBudget,
  readKeypairBytes,
  resolveTokenMint,
} from "./utils.js";

const DEFAULT_ADMIN_KEYPAIR = "./.temp/solana-admin.json";

async function fetchOraclePublicKeys(rpc) {
  const accounts = await rpc
    .getProgramAccounts(QS_BRIDGE_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [
        { dataSize: BigInt(getOracleSize()) },
        { memcmp: { offset: 0n, bytes: "2", encoding: "base58" } },
      ],
    })
    .send();

  const decoder = getOracleDecoder();
  return accounts.map((entry) => {
    const data = new Uint8Array(Buffer.from(entry.account.data[0], "base64"));
    return decoder.decode(data).oraclePubkey;
  });
}

async function main() {
  const adminKeyPath = process.env.ADMIN_KEYPAIR || DEFAULT_ADMIN_KEYPAIR;
  const tokenMint = resolveTokenMint();

  const { rpc, sendAndConfirmTransaction } = createRpcClients();

  const adminBytes = await readKeypairBytes(adminKeyPath, "Admin keypair file");
  const adminSigner = await createKeyPairSignerFromBytes(adminBytes);

  process.stdout.write("Fetching registered oracles from chain...\n");
  const oracleKeys = await fetchOraclePublicKeys(rpc);
  if (oracleKeys.length === 0) throw new Error("No oracles registered on chain");
  process.stdout.write(`Found ${oracleKeys.length} oracles\n`);

  const [globalStatePda] = await findGlobalStatePda();

  const oraclePdas = await Promise.all(
    oracleKeys.map(async (key) => {
      const [pda] = await findOraclePda({ oracle: address(key) });
      return pda;
    })
  );

  const extendAddresses = [
    ...oraclePdas,
    globalStatePda,
    address(tokenMint),
    TOKEN_PROGRAM_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    address(QS_BRIDGE_PROGRAM_ADDRESS),
  ];

  const slot = await rpc.getSlot().send();

  const lutPda = await findAddressLookupTablePda({
    authority: adminSigner.address,
    recentSlot: slot,
  });
  const lutAddress = lutPda[0];

  const createIx = getCreateLookupTableInstruction({
    address: lutPda,
    authority: adminSigner,
    recentSlot: slot,
  });

  const extendIx = getExtendLookupTableInstruction({
    address: lutAddress,
    addresses: extendAddresses,
    payer: adminSigner,
    authority: adminSigner,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = applyComputeBudget(
    appendTransactionMessageInstructions(
      [createIx, extendIx],
      setTransactionMessageLifetimeUsingBlockhash(
        latestBlockhash,
        setTransactionMessageFeePayer(
          adminSigner.address,
          createTransactionMessage({ version: 0 })
        )
      )
    ),
    { computeUnitLimit: 300_000 }
  );

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTransaction);

  await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });

  process.stdout.write(
    `\nLookup table created: ${lutAddress}\n` +
      `Transaction: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n\n` +
      `Add this to your .env.local:\n` +
      `SOLANA_LOOKUP_TABLE_ADDRESS=${lutAddress}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
