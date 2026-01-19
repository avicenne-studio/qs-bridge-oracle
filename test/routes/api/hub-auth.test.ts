import { test } from "node:test";
import assert from "node:assert";
import { build } from "../../helper.js";
import { signHubHeaders } from "../../utils/hub-signing.js";
import {
  HUB_AUTH_TIME_SKEW_SECONDS,
  HUB_NONCE_CLEANUP_BUFFER_SECONDS,
} from "../../../src/plugins/app/hub/hub-verifier.js";
import {
  kHubNoncesRepository,
  type HubNoncesRepository,
} from "../../../src/plugins/app/hub/hub-nonces.repository.js";

test("rejects requests missing hub auth headers", async (t) => {
  const app = await build(t);
  const { mock: warnMock } = t.mock.method(app.log, "warn");

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
  });

  assert.strictEqual(res.statusCode, 401);
  const hasLog = warnMock.calls.some((call) => {
    const [payload, message] = call.arguments as [{ reason: string }, string];
    return message === "Unauthorized hub request" && payload.reason === "invalid-headers";
  });
  assert.ok(hasLog);
});

test("rejects empty hub auth headers", async (t) => {
  const app = await build(t);
  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Hub-Id"] = "";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("accepts valid hub signatures", async (t) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers: await signHubHeaders({ method: "GET", url: "/api/health" }),
  });

  assert.strictEqual(res.statusCode, 200);
});

test("accepts signatures using the next key", async (t) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers: await signHubHeaders({
      method: "GET",
      url: "/api/health",
      kid: "primary-next",
    }),
  });

  assert.strictEqual(res.statusCode, 200);
});

test("rejects replayed nonces within the window", async (t) => {
  const app = await build(t);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Buffer.from("replay").toString("base64");
  const headers = await signHubHeaders({
    method: "GET",
    url: "/api/health",
    timestamp,
    nonce,
  });

  const first = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });
  assert.strictEqual(first.statusCode, 200);

  const second = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });
  assert.strictEqual(second.statusCode, 401);
});

test("allows nonce reuse after cleanup with a valid timestamp", async (t) => {
  const app = await build(t);
  const hubNoncesRepository: HubNoncesRepository =
    app.getDecorator(kHubNoncesRepository);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nonce = Buffer.from("cleanup").toString("base64");
  const headers = await signHubHeaders({
    method: "GET",
    url: "/api/health",
    nonce,
    timestamp: nowSeconds.toString(),
  });

  await hubNoncesRepository.insert({
    hubId: headers["X-Hub-Id"],
    kid: headers["X-Key-Id"],
    nonce,
    ts:
      nowSeconds -
      HUB_AUTH_TIME_SKEW_SECONDS -
      HUB_NONCE_CLEANUP_BUFFER_SECONDS -
      5,
  });

  await hubNoncesRepository.deleteExpired(
    nowSeconds - HUB_AUTH_TIME_SKEW_SECONDS - HUB_NONCE_CLEANUP_BUFFER_SECONDS
  );

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 200);
});

test("rejects invalid body hashes", async (t) => {
  const app = await build(t);

  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Body-Hash"] = "deadbeef";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects body hash mismatches", async (t) => {
  const app = await build(t);
  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Body-Hash"] = "0".repeat(64);

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects invalid timestamps", async (t) => {
  const app = await build(t);

  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Timestamp"] = "not-a-number";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects timestamps outside the skew window", async (t) => {
  const app = await build(t);

  const timestamp = (Math.floor(Date.now() / 1000) - 120).toString();
  const headers = await signHubHeaders({
    method: "GET",
    url: "/api/health",
    timestamp,
  });

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects unknown key ids", async (t) => {
  const app = await build(t);

  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Key-Id"] = "unknown-key";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects unknown hub ids", async (t) => {
  const app = await build(t);

  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Hub-Id"] = "unknown-hub";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects requests when nonce insert fails", async (t) => {
  const app = await build(t);
  const { mock: insertMock } = t.mock.method(
    app.getDecorator<HubNoncesRepository>(kHubNoncesRepository),
    "insert"
  );
  insertMock.mockImplementation(() => {
    throw new Error("insert failed");
  });

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers: await signHubHeaders({ method: "GET", url: "/api/health" }),
  });

  assert.strictEqual(res.statusCode, 401);
});

test("rejects invalid signatures", async (t) => {
  const app = await build(t);
  const { mock: warnMock } = t.mock.method(app.log, "warn");

  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Signature"] = "invalid-signature";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
  const hasLog = warnMock.calls.some((call) => {
    const [payload, message] = call.arguments as [{ reason: string }, string];
    return message === "Unauthorized hub request" && payload.reason === "invalid-signature";
  });
  assert.ok(hasLog);
});

test("does not insert nonce when signature verification fails", async (t) => {
  const app = await build(t);
  const { mock: insertMock } = t.mock.method(
    app.getDecorator<HubNoncesRepository>(kHubNoncesRepository),
    "insert"
  );

  const headers = await signHubHeaders({ method: "GET", url: "/api/health" });
  headers["X-Signature"] = "invalid-signature";

  const res = await app.inject({
    url: "/api/health",
    method: "GET",
    headers,
  });

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(insertMock.calls.length, 0);
});
