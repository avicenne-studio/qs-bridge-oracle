import Fastify from "fastify";
import { Buffer } from "node:buffer";
import type { TestContext } from "node:test";

/**
 * Starts a mock Qubic RPC server that exposes the endpoints used by relay-qubic.ts:
 * - GET  /live/v1/tick-info
 * - POST /live/v1/querySmartContract (GetOracles)
 * - POST /live/v1/broadcast-transaction
 *
 * @param behavior - controls whether broadcast succeeds, fails, or returns errors
 */
export async function startQubicRpcMock(
  t: TestContext,
  behavior: {
    broadcastResult?: "success" | "fail" | "error";
    broadcastStatusCode?: number;
    oracleCount?: number;
  } = {},
) {
  const { broadcastResult = "success", broadcastStatusCode = 200, oracleCount = 0 } = behavior;
  const server = Fastify({ logger: false });
  let broadcastCallCount = 0;

  server.get("/live/v1/tick-info", async () => {
    return { tick: 100, epoch: 1 };
  });

  server.post("/live/v1/querySmartContract", async () => {
    // Return GetOracles_output: count (u32) + Array<id, 64> (each 32 bytes)
    const buf = Buffer.alloc(4 + 64 * 32);
    buf.writeUInt32LE(oracleCount, 0);
    return { responseData: buf.toString("base64") };
  });

  server.post("/live/v1/broadcast-transaction", async (_req, reply) => {
    broadcastCallCount += 1;
    if (broadcastResult === "fail") {
      return reply.code(broadcastStatusCode || 500).send({ error: "broadcast failed" });
    }
    if (broadcastResult === "error") {
      return reply.code(429).send({ message: "Too Many Requests" });
    }
    return { transactionId: `qubic-tx-${broadcastCallCount}`, peersBroadcasted: 3 };
  });

  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => server.close());

  return { url, getBroadcastCallCount: () => broadcastCallCount };
}
