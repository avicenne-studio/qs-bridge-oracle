import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  createSignableMessage,
  AccountRole,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBytesEncoder,
  getSignatureFromTransaction,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { findGlobalStatePda } from "../dist/clients/js/pdas/globalState.js";
import { findOraclePda } from "../dist/clients/js/pdas/oracle.js";
import { findInboundOrderPda } from "../dist/clients/js/pdas/inboundOrder.js";
import { getInboundInstruction } from "../dist/clients/js/instructions/inbound.js";
import { QS_BRIDGE_PROGRAM_ADDRESS } from "../dist/clients/js/programs/qsBridge.js";
import { fetchGlobalState } from "../dist/clients/js/accounts/globalState.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  RENT_SYSVAR_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  createRpcClients,
  applyComputeBudget,
  findAssociatedTokenAddress,
  logSection,
  parseKeypairBytes,
  readJson,
  resolveRpcUrl,
  resolveWsUrl,
} from "./utils.js";

const ORACLE_THRESHOLD_PERCENT = 60;
const DEFAULT_PROTOCOL_NAME = "QubicBridge";
const DEFAULT_PROTOCOL_VERSION = "1";

const HEX_PATTERN = /^[0-9a-fA-F]+$/;

function parseBytes32(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a hex or base58 string`);
  }

  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length === 64 && HEX_PATTERN.test(normalized)) {
    return new Uint8Array(Buffer.from(normalized, "hex"));
  }

  const addr = address(value);
  const bytes = new Uint8Array(getAddressEncoder().encode(addr));
  if (bytes.length !== 32) {
    throw new Error(`${field} must decode to 32 bytes`);
  }
  return bytes;
}

function encodeString(value) {
  const stringBytes = getUtf8Encoder().encode(value);
  const lengthBytes = getU32Encoder().encode(stringBytes.length);
  return concatBytes([new Uint8Array(lengthBytes), new Uint8Array(stringBytes)]);
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function serializeInboundOrder(payload) {
  return concatBytes([
    encodeString(payload.protocolName),
    encodeString(payload.protocolVersion),
    new Uint8Array(getBytesEncoder().encode(payload.contractAddress)),
    new Uint8Array(getU32Encoder().encode(payload.networkIn)),
    new Uint8Array(getU32Encoder().encode(payload.networkOut)),
    new Uint8Array(getBytesEncoder().encode(payload.tokenIn)),
    new Uint8Array(getBytesEncoder().encode(payload.tokenOut)),
    new Uint8Array(getBytesEncoder().encode(payload.fromAddress)),
    new Uint8Array(getBytesEncoder().encode(payload.toAddress)),
    new Uint8Array(getU64Encoder().encode(payload.amount)),
    new Uint8Array(getU64Encoder().encode(payload.relayerFee)),
    new Uint8Array(getBytesEncoder().encode(payload.nonce)),
  ]);
}

async function signInboundOrder(payload, signer) {
  const serialized = serializeInboundOrder(payload);
  const digest = createHash("sha256").update(serialized).digest();
  const signable = createSignableMessage(digest);
  const [sigDict] = await signer.signMessages([signable]);
  const signature = sigDict?.[signer.address];
  if (!signature) {
    throw new Error("Signer did not return a signature");
  }
  return new Uint8Array(signature);
}

function getCreateAssociatedTokenAccountInstruction({
  payerSigner,
  ata,
  owner,
  mint,
  tokenProgram,
  associatedTokenProgram,
  systemProgram,
  rentSysvar,
}) {
  return {
    programAddress: associatedTokenProgram,
    accounts: [
      {
        address: payerSigner.address,
        role: AccountRole.WRITABLE_SIGNER,
        signer: payerSigner,
      },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: systemProgram, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
      { address: rentSysvar, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(),
  };
}

function padToLength(items, length, filler) {
  if (items.length >= length) {
    return items.slice(0, length);
  }
  const padding = Array.from({ length: length - items.length }, () => filler);
  return items.concat(padding);
}

async function checkAccountExists(rpc, account, label) {
  const result = await rpc.getAccountInfo(account, { encoding: "base64" }).send();
  if (!result?.value) {
    process.stderr.write(`Missing account: ${label} (${account})\n`);
    return false;
  }
  return true;
}

async function main() {
  const orderPath = process.argv[2];
  const oracleKeysPath = process.argv[3];
  const relayerKeyPath = process.argv[4];
  if (!orderPath || !oracleKeysPath || !relayerKeyPath) {
    throw new Error(
      "Usage: node scripts/send-inbound-order.js <order.json> <oracle-keys.json> <relayer-key.json>"
    );
  }

  const rpcUrl = resolveRpcUrl();
  const wsUrl = resolveWsUrl();

  const order = await readJson(orderPath);
  const oracleKeys = await readJson(oracleKeysPath);
  const relayerKey = await readJson(relayerKeyPath);

  const relayerSigner = await createKeyPairSignerFromBytes(
    parseKeypairBytes(relayerKey, "Relayer keypair")
  );

  const oracleSigners = await Promise.all(
    oracleKeys.map((entry, index) =>
      createKeyPairSignerFromBytes(
        parseKeypairBytes(entry, `Oracle keypair #${index + 1}`)
      )
    )
  );

  const networkIn = Number(order.networkIn);
  const networkOut = Number(order.networkOut);
  const tokenIn = parseBytes32(order.tokenIn, "tokenIn");
  const fromAddress = parseBytes32(order.fromAddress, "fromAddress");
  const toAddress = parseBytes32(order.toAddress, "toAddress");
  const amount = BigInt(order.amount);
  const relayerFee = BigInt(order.relayerFee);
  const nonce = parseBytes32(order.nonce, "nonce");
  const protocolName = order.protocolName || DEFAULT_PROTOCOL_NAME;
  const protocolVersion = order.protocolVersion || DEFAULT_PROTOCOL_VERSION;

  const recipient = address(order.recipient);

  const { rpc, sendAndConfirmTransaction } = createRpcClients(rpcUrl, wsUrl);

  const [globalStatePda] = await findGlobalStatePda();
  const globalState = await fetchGlobalState(rpc, globalStatePda);
  const tokenMint = globalState.data.tokenMint;

  const tokenOut = parseBytes32(tokenMint, "tokenOut");

  logSection("send-inbound-order", "Inputs");
  process.stdout.write(
    JSON.stringify(
      {
        orderPath,
        oracleKeysPath,
        relayerKeyPath,
        relayer: relayerSigner.address,
        recipient,
        tokenMint,
        networkIn,
        networkOut,
        amount: amount.toString(),
        relayerFee: relayerFee.toString(),
        nonce: Buffer.from(nonce).toString("hex"),
      },
      null,
      2
    ) + "\n"
  );

  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;
  const systemProgram = SYSTEM_PROGRAM_ADDRESS;
  const rentSysvar = RENT_SYSVAR_ADDRESS;

  const recipientAta = await findAssociatedTokenAddress(
    recipient,
    tokenMint,
    tokenProgram,
    associatedTokenProgram
  );
  const relayerAta = await findAssociatedTokenAddress(
    relayerSigner.address,
    tokenMint,
    tokenProgram,
    associatedTokenProgram
  );

  logSection("send-inbound-order", "Owner accounts");
  const relayerAccount = await rpc
    .getAccountInfo(relayerSigner.address, { encoding: "base64" })
    .send();
  const recipientAccount = await rpc
    .getAccountInfo(recipient, { encoding: "base64" })
    .send();
  process.stdout.write(
    `relayer exists: ${!!relayerAccount?.value}\n` +
      `recipient exists: ${!!recipientAccount?.value}\n`
  );
  if (!relayerAccount?.value) {
    process.stderr.write(
      "Relayer account not found. Fund the relayer address with devnet SOL.\n"
    );
    return;
  }
  if (!recipientAccount?.value) {
    process.stderr.write(
      "Recipient account not found. Fund the recipient address with devnet SOL.\n"
    );
    return;
  }

  const ataTargets = [
    { label: "recipientAta", address: recipientAta, owner: recipient },
    {
      label: "relayerAta",
      address: relayerAta,
      owner: relayerSigner.address,
    },
  ];

  for (const target of ataTargets) {
    const accountInfo = await rpc
      .getAccountInfo(target.address, { encoding: "base64" })
      .send();
    if (!accountInfo?.value) {
      logSection("send-inbound-order", `Creating ${target.label}`);
      const ix = getCreateAssociatedTokenAccountInstruction({
        payerSigner: relayerSigner,
        ata: target.address,
        owner: target.owner,
        mint: tokenMint,
        tokenProgram,
        associatedTokenProgram,
        systemProgram,
        rentSysvar,
      });
      const { value: blockhash } = await rpc.getLatestBlockhash().send();
      const ataMessage = applyComputeBudget(
        appendTransactionMessageInstruction(
          ix,
          setTransactionMessageLifetimeUsingBlockhash(
            blockhash,
            setTransactionMessageFeePayer(
              relayerSigner.address,
              createTransactionMessage({ version: "legacy" })
            )
          )
        )
      );
      const ataTx = await signTransactionMessageWithSigners(ataMessage);
      const ataSig = getSignatureFromTransaction(ataTx);
      if (typeof rpc.simulateTransaction === "function") {
        const encodedAta = getBase64EncodedWireTransaction(ataTx);
        const simulation = await rpc
          .simulateTransaction(encodedAta, {
            encoding: "base64",
            sigVerify: false,
            replaceRecentBlockhash: true,
          })
          .send();
        if (simulation?.value?.err) {
          process.stderr.write(
            `ATA simulation error: ${JSON.stringify(
              simulation.value.err,
              (_key, value) =>
                typeof value === "bigint" ? value.toString() : value
            )}\n`
          );
          if (simulation.value.logs?.length) {
            process.stderr.write(
              `ATA simulation logs:\n${simulation.value.logs.join("\n")}\n`
            );
          }
          return;
        }
      }
      await sendAndConfirmTransaction(ataTx, { commitment: "confirmed" });
      process.stdout.write(`Created ${target.label}: ${target.address}\n`);
      process.stdout.write(
        `ATA tx: ${ataSig}\n` +
          `Explorer: https://solscan.io/tx/${ataSig}?cluster=devnet\n`
      );
    }
  }

  const contractAddressBytes = new Uint8Array(
    getAddressEncoder().encode(address(QS_BRIDGE_PROGRAM_ADDRESS))
  );

  const orderPayload = {
    protocolName,
    protocolVersion,
    contractAddress: contractAddressBytes,
    networkIn,
    networkOut,
    tokenIn,
    tokenOut,
    fromAddress,
    toAddress,
    amount,
    relayerFee,
    nonce,
  };

  const oracleCount = globalState.data.oracleCount;
  const signatureOverride = process.env.SIGNATURE_COUNT
    ? Number(process.env.SIGNATURE_COUNT)
    : null;
  const signatureCount =
    signatureOverride && Number.isFinite(signatureOverride)
      ? Math.max(1, Math.min(6, Math.floor(signatureOverride)))
      : Math.min(
          Math.max(1, Math.ceil(oracleCount * (ORACLE_THRESHOLD_PERCENT / 100))),
          6
        );
  logSection("send-inbound-order", "Oracle threshold");
  process.stdout.write(
    JSON.stringify(
      {
        oracleCount,
        thresholdPercent: ORACLE_THRESHOLD_PERCENT,
        signatureOverride,
        signatureCount,
      },
      null,
      2
    ) + "\n"
  );
  if (oracleSigners.length < signatureCount) {
    throw new Error(
      `Need ${signatureCount} oracle keys, got ${oracleSigners.length}`
    );
  }

  const signingOracles = oracleSigners.slice(0, signatureCount);
  const signatures = [];
  for (const signer of signingOracles) {
    signatures.push(await signInboundOrder(orderPayload, signer));
  }

  const oracleAddresses = signingOracles.map((signer) => signer.address);
  const oraclePdas = await Promise.all(
    oracleAddresses.map(async (oracle) => {
      const [oraclePda] = await findOraclePda({ oracle });
      return oraclePda;
    })
  );
  const paddedOraclePdas = padToLength(oraclePdas, 6, oraclePdas[0]);
  logSection("send-inbound-order", "Oracle PDAs");
  paddedOraclePdas.forEach((oraclePda, index) => {
    process.stdout.write(`oracle${index + 1}: ${oraclePda}\n`);
  });

  const requiredAccounts = [
    { label: "globalState", address: globalStatePda },
    { label: "tokenMint", address: tokenMint },
    { label: "recipientAta", address: recipientAta },
    { label: "relayerAta", address: relayerAta },
  ];
  const oracleAccountChecks = paddedOraclePdas.map((oraclePda, index) => ({
    label: `oraclePda${index + 1}`,
    address: oraclePda,
  }));
  const missingChecks = await Promise.all(
    requiredAccounts
      .concat(oracleAccountChecks)
      .map((entry) => checkAccountExists(rpc, entry.address, entry.label))
  );
  if (missingChecks.some((exists) => !exists)) {
    process.stderr.write(
      "Create missing accounts (or ensure oracles are added) before retrying.\n"
    );
    return;
  }

  const [inboundOrderPda] = await findInboundOrderPda({
    networkIn,
    nonce,
  });
  logSection("send-inbound-order", "Inbound order PDA");
  process.stdout.write(`inboundOrderPda: ${inboundOrderPda}\n`);
  const existingInbound = await rpc
    .getAccountInfo(inboundOrderPda, { encoding: "base64" })
    .send();
  if (existingInbound?.value) {
    throw new Error(
      "Inbound order already exists for this nonce. Update order.json with a new nonce."
    );
  }

  const instruction = getInboundInstruction({
    relayer: relayerSigner,
    globalState: globalStatePda,
    tokenMint,
    recipient,
    recipientAta,
    relayerAta,
    inboundOrderPda,
    tokenProgram,
    associatedTokenProgram,
    oracle1Pda: paddedOraclePdas[0],
    oracle2Pda: paddedOraclePdas[1],
    oracle3Pda: paddedOraclePdas[2],
    oracle4Pda: paddedOraclePdas[3],
    oracle5Pda: paddedOraclePdas[4],
    oracle6Pda: paddedOraclePdas[5],
    order: {
      networkIn,
      networkOut,
      tokenIn,
      tokenOut,
      fromAddress,
      toAddress,
      amount,
      relayerFee,
      nonce,
    },
    signatures,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  let message = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash,
    setTransactionMessageFeePayer(
      relayerSigner.address,
      createTransactionMessage({ version: "legacy" })
    )
  );
  message = appendTransactionMessageInstruction(instruction, message);
  message = applyComputeBudget(message);

  const signedTransaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTransaction);

  logSection("send-inbound-order", "Transaction");
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
    `Inbound order sent. Transaction signature: ${signature}\n` +
      `Explorer: https://solscan.io/tx/${signature}?cluster=devnet\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exit(1);
});
