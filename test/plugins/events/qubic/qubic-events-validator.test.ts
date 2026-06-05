import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createQubicEventValidator,
} from "../../../../src/plugins/app/events/qubic/qubic-events-validator.js";
import {
  FUNC_GET_LOCKED_ORDER,
  FUNC_IS_ORDER_FILLED,
  encodeGetLockedOrderInput,
  type QubicContractClient,
} from "../../../../src/plugins/infra/qubic-contract-client.js";

// Build a GetLockedOrder_output hex (176 bytes):
//   [0]       bit exists
//   [1..7]    padding
//   [8..175]  LockedOrderEntry (168 bytes)
function buildLockedOrderHex(opts: {
  exists?: boolean;
  sender?: string;   // 64-char hex (32 bytes)
  amount?: bigint;
  relayerFee?: bigint;
  networkOut?: number;
  nonce?: number;
  active?: boolean;
} = {}): string {
  const buf = Buffer.alloc(176);
  buf.writeUInt8(opts.exists !== false ? 1 : 0, 0);
  const off = 8;
  buf.set(Buffer.from(opts.sender ?? "aa".repeat(32), "hex"), off);
  buf.writeBigUInt64LE(opts.amount ?? 1000n, off + 32);
  buf.writeBigUInt64LE(opts.relayerFee ?? 10n, off + 40);
  buf.writeUInt32LE(opts.networkOut ?? 2, off + 48);
  buf.writeUInt32LE(opts.nonce ?? 42, off + 52);
  buf.writeUInt8(opts.active !== false ? 1 : 0, off + 160);
  return buf.toString("hex");
}

const baseEvent = {
  id: 1,
  signature: "orderhashhex",
  slot: null,
  chain: "qubic" as const,
  type: "lock" as const,
  nonce: "0000002a",
  payload: {
    fromAddress: "aa".repeat(32),
    toAddress: "SolanaAddressHere",
    amount: "1000",
    relayerFee: "10",
    nonce: "0000002a",
    orderEra: "0",
  },
  createdAt: "2024-01-01 00:00:00",
};

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
};

function makeClient(respond: () => Promise<string>): QubicContractClient {
  return {
    queryContractFunction: () => respond(),
  };
}

test("qubic event validator accepts a matching lock order", async () => {
  const client = makeClient(async () => buildLockedOrderHex());
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await validator.validate(baseEvent);
});

test("qubic event validator passes the correct nonce to the contract client", async () => {
  let capturedFunc: number | undefined;
  let capturedInput: string | undefined;
  const client: QubicContractClient = {
    async queryContractFunction(funcNumber, inputHex) {
      capturedFunc = funcNumber;
      capturedInput = inputHex;
      return buildLockedOrderHex();
    },
  };
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await validator.validate(baseEvent);
  assert.strictEqual(capturedFunc, FUNC_GET_LOCKED_ORDER);
  assert.strictEqual(capturedInput, encodeGetLockedOrderInput(42));
});

test("qubic event validator throws when order is not found", async () => {
  const client = makeClient(async () => buildLockedOrderHex({ exists: false }));
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(() => validator.validate(baseEvent), /Order not found/);
});

test("qubic event validator throws on amount mismatch", async () => {
  const client = makeClient(async () => buildLockedOrderHex({ amount: 999n }));
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(() => validator.validate(baseEvent), /Order amount mismatch/);
});

test("qubic event validator throws on relayerFee mismatch", async () => {
  const client = makeClient(async () => buildLockedOrderHex({ relayerFee: 9n }));
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(() => validator.validate(baseEvent), /Order relayerFee mismatch/);
});

test("qubic event validator throws on networkOut mismatch", async () => {
  const client = makeClient(async () => buildLockedOrderHex({ networkOut: 3 }));
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(() => validator.validate(baseEvent), /Order networkOut mismatch/);
});

test("qubic event validator throws on sender mismatch", async () => {
  const client = makeClient(async () => buildLockedOrderHex({ sender: "bb".repeat(32) }));
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(() => validator.validate(baseEvent), /Order sender mismatch/);
});

test("qubic event validator rethrows contract query errors", async () => {
  const client: QubicContractClient = {
    async queryContractFunction() {
      throw new Error("boom");
    },
  };
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(() => validator.validate(baseEvent), /boom/);
});

test("qubic event validator accepts override-lock event with matching fields", async () => {
  const client = makeClient(async () => buildLockedOrderHex());
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await validator.validate({ ...baseEvent, type: "override-lock" as const });
});

test("qubic event validator skips field checks for unlock events", async () => {
  let capturedFunc: number | undefined;
  let capturedInput: string | undefined;
  const client: QubicContractClient = {
    async queryContractFunction(funcNumber, inputHex) {
      capturedFunc = funcNumber;
      capturedInput = inputHex;
      return "01";
    },
  };
  const validator = createQubicEventValidator({ contractClient: client, logger });
  const unlockEvent = {
    ...baseEvent,
    signature: "ab".repeat(32),
    type: "unlock" as const,
    nonce: "",
    payload: { toAddress: "0".repeat(64), amount: "0", nonce: "" },
  };
  await validator.validate(unlockEvent);
  assert.strictEqual(capturedFunc, FUNC_IS_ORDER_FILLED);
  assert.strictEqual(capturedInput, "ab".repeat(32));
});

test("qubic event validator rethrows contract query errors for unlock events", async () => {
  const client: QubicContractClient = {
    async queryContractFunction() {
      throw new Error("unlock-query-boom");
    },
  };
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(
    () =>
      validator.validate({
        ...baseEvent,
        signature: "ef".repeat(32),
        type: "unlock" as const,
        nonce: "",
        payload: { toAddress: "0".repeat(64), amount: "0", nonce: "" },
      }),
    /unlock-query-boom/,
  );
});

test("qubic event validator throws when unlock order hash is not filled", async () => {
  const client: QubicContractClient = {
    async queryContractFunction() {
      return "00";
    },
  };
  const validator = createQubicEventValidator({ contractClient: client, logger });
  await assert.rejects(
    () =>
      validator.validate({
        ...baseEvent,
        signature: "cd".repeat(32),
        type: "unlock" as const,
        nonce: "",
        payload: { toAddress: "0".repeat(64), amount: "0", nonce: "" },
      }),
    /Order not filled/,
  );
});
