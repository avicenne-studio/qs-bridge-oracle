import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";

const PORT = Number(globalThis.process.env.FAKE_QUBIC_PORT ?? "3015");
const HOST = globalThis.process.env.FAKE_QUBIC_HOST ?? "127.0.0.1";

const fastify = Fastify({ logger: true });

const events = [];
const transactions = new Map();
const unlocks = [];
const unlockedNonces = new Set();
const state = {
  orders: new Map(), // nonce -> order
};

function nowIso() {
  return new Date().toISOString();
}

const qubicIdPattern = /^[A-Z]+$/;
const hex32Pattern = /^(0x)?[0-9a-f]{64}$/i;

function isQubicId(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!qubicIdPattern.test(trimmed)) {
    return false;
  }
  return trimmed.length >= 48 && trimmed.length <= 60 && trimmed.length % 4 === 0;
}

function isHex32(value) {
  if (typeof value !== "string") {
    return false;
  }
  return hex32Pattern.test(value.trim());
}

function assertValidQubicAddress(value, label) {
  if (isQubicId(value) || isHex32(value)) {
    return;
  }
  throw new Error(`${label} is invalid`);
}

function toHexHash(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

function buildTransaction(event) {
  const trxHash = toHexHash(`${event.type}:${event.nonce}:${event.orderHash}`);
  event.trxHash = trxHash;
  const stored = {
    trxHash,
    logs: [event],
    createdAt: nowIso(),
  };
  transactions.set(trxHash, stored);
  return stored;
}

function storeEvent(type, payload) {
  const orderHash = toHexHash(
    `${type}:${payload.nonce}:${payload.fromAddress ?? ""}:${payload.toAddress ?? ""}:${payload.amount ?? ""}:${payload.relayerFee ?? ""}`,
  );
  const event = {
    chain: "qubic",
    type,
    nonce: payload.nonce,
    orderHash,
    payload,
    createdAt: nowIso(),
  };
  events.push(event);
  return event;
}

function matchesExpected(event, expected) {
  if (!expected) {
    return true;
  }
  if (expected.type && expected.type !== event.type) {
    return false;
  }
  if (expected.nonce && expected.nonce !== event.nonce) {
    return false;
  }
  const expectedPayload = expected.payload ?? {};
  const payload = event.payload ?? {};
  for (const [key, value] of Object.entries(expectedPayload)) {
    if (value !== undefined && payload[key] !== value) {
      return false;
    }
  }
  return true;
}

fastify.post("/lock", async (request, reply) => {
  const body = request.body ?? {};
  const nonce = String(body.nonce ?? Date.now());
  const fromAddress = String(body.from ?? "");
  try {
    assertValidQubicAddress(fromAddress, "from");
  } catch (err) {
    return reply.code(400).send({ message: err.message });
  }
  const payload = {
    fromAddress,
    toAddress: String(body.to ?? ""),
    amount: String(body.amount ?? "0"),
    relayerFee: String(body.relayerFee ?? "0"),
    networkOut: Number(body.networkOut ?? 1),
    nonce,
  };

  if (state.orders.has(nonce)) {
    return reply.code(409).send({ message: "nonce already used" });
  }

  const event = storeEvent("lock", payload);
  state.orders.set(nonce, {
    ...payload,
    orderHash: event.orderHash,
  });
  const tx = buildTransaction(event);

  return reply.code(201).send({
    trxHash: tx.trxHash,
    event,
  });
});

fastify.post("/override-lock", async (request, reply) => {
  const body = request.body ?? {};
  const payload = {
    toAddress: String(body.to ?? ""),
    relayerFee: String(body.relayerFee ?? "0"),
    nonce: String(body.nonce ?? ""),
  };

  if (!payload.nonce) {
    return reply.code(400).send({ message: "nonce is required" });
  }
  const existing = state.orders.get(payload.nonce);
  if (!existing) {
    return reply.code(404).send({ message: "order not found" });
  }

  const event = storeEvent("override-lock", {
    ...payload,
    fromAddress: existing.fromAddress,
    amount: existing.amount,
  });
  state.orders.set(payload.nonce, {
    ...existing,
    toAddress: payload.toAddress,
    relayerFee: payload.relayerFee,
    orderHash: event.orderHash,
  });
  const tx = buildTransaction(event);

  return reply.code(201).send({
    trxHash: tx.trxHash,
    event,
  });
});

fastify.post("/unlock", async (request, reply) => {
  const body = request.body ?? {};
  const toAddress = String(body.to ?? "");
  try {
    assertValidQubicAddress(toAddress, "to");
  } catch (err) {
    return reply.code(400).send({ message: err.message });
  }
  const payload = {
    toAddress,
    amount: String(body.amount ?? "0"),
    nonce: String(body.nonce ?? Date.now()),
  };
  if (unlockedNonces.has(payload.nonce)) {
    return reply.code(409).send({ message: "nonce already unlocked" });
  }
  const event = storeEvent("unlock", payload);
  const tx = buildTransaction(event);
  const record = {
    trxHash: tx.trxHash ?? String(body.trxHash ?? randomUUID()),
    toAddress: payload.toAddress,
    amount: payload.amount,
    nonce: payload.nonce,
    createdAt: nowIso(),
  };
  unlockedNonces.add(payload.nonce);
  unlocks.push(record);
  return reply.code(201).send({ trxHash: record.trxHash, event });
});

fastify.get("/events", async (_request, reply) => {
  return reply.send({ data: events });
});

fastify.get("/transactions/:trxHash", async (request, reply) => {
  const { trxHash } = request.params;
  const tx = transactions.get(trxHash);
  if (!tx) {
    return reply.code(404).send({ message: "transaction not found" });
  }

  let expected = null;
  if (request.query?.expected) {
    try {
      expected = JSON.parse(String(request.query.expected));
    } catch {
      return reply.code(400).send({ message: "invalid expected payload" });
    }
  }

  const matches = tx.logs.some((log) => matchesExpected(log, expected));
  return reply.send({
    trxHash: tx.trxHash,
    matches,
    logs: tx.logs,
  });
});

fastify.get("/transactions", async (_request, reply) => {
  return reply.send({
    data: Array.from(transactions.values()),
  });
});

fastify.get("/unlocks", async (_request, reply) => {
  return reply.send({ data: unlocks });
});

fastify.listen({ port: PORT, host: HOST }).catch((err) => {
  fastify.log.error({ err }, "Failed to start fake Qubic contract");
  globalThis.process.exit(1);
});
