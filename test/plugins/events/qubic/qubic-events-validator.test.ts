import { test } from "node:test";
import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import {
  createQubicEventValidator,
  createDefaultQubicTransactionFetcher,
  type QubicTransactionFetcher,
} from "../../../../src/plugins/app/events/qubic/qubic-events-validator.js";

const baseEvent = {
  id: 1,
  signature: "trx-hash",
  slot: null,
  chain: "qubic" as const,
  type: "lock" as const,
  nonce: "42",
  payload: {
    fromAddress: "id(1,2,3,4)",
    toAddress: "0xabc",
    amount: "10",
    relayerFee: "1",
    nonce: "42",
  },
  createdAt: "2024-01-01 00:00:00",
};

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
};

const validation = {
  isValid<T>(schema: TSchema, value: unknown): value is T {
    return Value.Check(schema, value);
  },
  assertValid<T>(_schema: TSchema, _value: unknown, _prefix: string): asserts _value is T {
    void _schema;
    void _value;
    void _prefix;
  },
};

test("qubic event validator accepts matching transactions", async () => {
  const fetchTransaction: QubicTransactionFetcher = async () => ({
    trxHash: "trx-hash",
    matches: true,
  });
  const validator = createQubicEventValidator({
    fetchTransaction,
    logger,
    validation,
  });

  await validator.validate(baseEvent);
});

test("qubic event validator rejects mismatched transactions", async () => {
  const fetchTransaction: QubicTransactionFetcher = async () => ({
    trxHash: "trx-hash",
    matches: false,
  });
  const validator = createQubicEventValidator({
    fetchTransaction,
    logger,
    validation,
  });

  await assert.rejects(
    () => validator.validate(baseEvent),
    /Transaction events do not match hub payload/
  );
});

test("qubic event validator reports missing transactions", async () => {
  const fetchTransaction: QubicTransactionFetcher = async () => {
    throw new Error("HTTP 404");
  };
  const validator = createQubicEventValidator({
    fetchTransaction,
    logger,
    validation,
  });

  await assert.rejects(
    () => validator.validate(baseEvent),
    /Transaction not found/
  );
});

test("qubic event validator rethrows unexpected fetch errors", async () => {
  const fetchTransaction: QubicTransactionFetcher = async () => {
    throw new Error("boom");
  };
  const validator = createQubicEventValidator({
    fetchTransaction,
    logger,
    validation,
  });

  await assert.rejects(() => validator.validate(baseEvent), /boom/);
});

test("qubic event validator handles non-error throws", async () => {
  const fetchTransaction: QubicTransactionFetcher = async () => {
    throw "boom";
  };
  const validator = createQubicEventValidator({
    fetchTransaction,
    logger,
    validation,
  });

  await assert.rejects(() => validator.validate(baseEvent));
});

test("qubic event validator rejects invalid transaction responses", async () => {
  const fetchTransaction: QubicTransactionFetcher = async () => ({
    trxHash: "trx-hash",
    matches: "nope" as never,
  });
  const validator = createQubicEventValidator({
    fetchTransaction,
    logger,
    validation,
  });

  await assert.rejects(
    () => validator.validate(baseEvent),
    /Transaction response invalid/
  );
});

test("default qubic transaction fetcher builds transaction paths", async () => {
  let captured: { origin?: string; path?: string } = {};
  const client = {
    async getJson(origin: string, path: string) {
      captured = { origin, path };
      return { trxHash: "trx-hash", matches: true };
    },
  } as never;

  const fetcher = createDefaultQubicTransactionFetcher(
    client,
    "http://127.0.0.1:3015"
  );

  await fetcher(baseEvent.signature, {
    type: baseEvent.type,
    nonce: baseEvent.nonce,
    payload: baseEvent.payload,
  });

  assert.strictEqual(captured.origin, "http://127.0.0.1:3015");
  assert.ok(captured.path?.startsWith("/transactions/trx-hash?expected="));
});

test("default qubic transaction fetcher trims trailing slashes", async () => {
  let captured: { origin?: string; path?: string } = {};
  const client = {
    async getJson(origin: string, path: string) {
      captured = { origin, path };
      return { trxHash: "trx-hash", matches: true };
    },
  } as never;

  const fetcher = createDefaultQubicTransactionFetcher(
    client,
    "http://127.0.0.1:3015/api/"
  );

  await fetcher(baseEvent.signature, {
    type: baseEvent.type,
    nonce: baseEvent.nonce,
    payload: baseEvent.payload,
  });

  assert.strictEqual(captured.origin, "http://127.0.0.1:3015");
  assert.ok(captured.path?.startsWith("/api/transactions/trx-hash?expected="));
});
