import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { build } from "../../helper.js";

const noop = () => {};

describe("poller plugin", () => {
  it("uses the primary response when it succeeds", async (t) => {
    const app = await build(t);

    const primary = "primary";
    const fallback = "fallback";
    const responsesByServer = new Map([
      ["primary", ["primary-r1", "primary-r2"]],
    ]);

    const pollResults: (string | null)[] = [];
    const calls: string[] = [];
    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const fetchOne = async (server: string) => {
      calls.push(server);

      const bucket = responsesByServer.get(server)!;
      const value = bucket.shift()!;
      return value;
    };

    const poller = app.poller.create({
      primary,
      fallback,
      fetchOne: (s: string) => fetchOne(s),
      onRound: (response, context) => {
        pollResults.push(response);

        if (context.round === 2) {
          // Do not await stop inside onRound. Stop after onRound returns.
          queueMicrotask(() => {
            poller.stop().then(() => done?.(), noop);
          });
        }
      },
      intervalMs: 50,
      requestTimeoutMs: 10,
      jitterMs: 15,
    });

    poller.start();
    await completion;

    assert.deepStrictEqual(pollResults, [
      "primary-r1",
      "primary-r2",
    ]);
    assert.deepStrictEqual(calls, ["primary", "primary"]);
    assert.strictEqual(poller.isRunning(), false);
  });

  it("falls back after a timeout and exposes defaults", async (t) => {
    const app = await build(t);

    const abortedServers: string[] = [];
    const primary = "slow";
    const fallback = "fast";

    const fetchOne = (server: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        if (server === fallback) {
          resolve("fast-response");
          return;
        }

        const onAbort = () => {
          abortedServers.push(server);
          signal.removeEventListener("abort", onAbort);
          reject(new Error("aborted"));
        };

        signal.addEventListener("abort", onAbort);
      });

    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const poller = app.poller.create({
      primary,
      fallback,
      fetchOne,
      onRound: (response, context) => {
        assert.strictEqual(response, "fast-response");
        assert.strictEqual(context.used, fallback);
        queueMicrotask(() => {
          poller.stop().then(() => done?.(), noop);
        });
      },
      intervalMs: 10,
      requestTimeoutMs: 50,
      jitterMs: 0,
    });

    assert.deepStrictEqual(app.poller.defaults, {
      intervalMs: 3000,
      requestTimeoutMs: 700,
      jitterMs: 25,
    });

    poller.start();
    await completion;

    assert.deepStrictEqual(abortedServers, ["slow"]);
    await poller.stop().catch(noop);
  });

  it("throws when start is invoked twice", async (t) => {
    const app = await build(t);

    const poller = app.poller.create({
      primary: "s1",
      fetchOne: async () => "ok",
      onRound: noop,
      intervalMs: 1,
      requestTimeoutMs: 10,
      jitterMs: 0,
    });

    poller.start();
    assert.throws(() => poller.start(), /already started/);
    await poller.stop();
  });

  it("integrates with the Undici GET client transport with fallback", async (t) => {
    const app = await build(t);

    const fastState = { count: 0 };
    const fastServer = createServer((req, res) => {
      fastState.count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ server: "fast", round: fastState.count })
      );
    });

    const failingServer = createServer((req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    const listen = async (srv: ReturnType<typeof createServer>) =>
      new Promise<AddressInfo>((resolve) => {
        srv.listen(0, () => resolve(srv.address() as AddressInfo));
      });

    const [fastAddr, failingAddr] = await Promise.all([
      listen(fastServer),
      listen(failingServer),
    ]);
    t.after(() => fastServer.close());
    t.after(() => failingServer.close());

    type Response = { server: string; round: number };

    const client = app.undiciGetClient.create();
    const observed: Response[] = [];

    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const poller = app.poller.create({
      primary: `http://127.0.0.1:${failingAddr.port}`,
      fallback: `http://127.0.0.1:${fastAddr.port}`,
      fetchOne: (server, signal) =>
        client.getJson<Response>(server, "/poll", signal),
      onRound: (response, context) => {
        assert.ok(response);
        observed.push(response);
        if (context.round === 2) {
          queueMicrotask(() => {
            poller.stop().then(() => done?.(), noop);
          });
        }
      },
      intervalMs: 10,
      requestTimeoutMs: 200,
      jitterMs: 0,
    });

    poller.start();
    await completion;

    assert.deepStrictEqual(observed, [
      { server: "fast", round: 1 },
      { server: "fast", round: 2 },
    ]);
    await client.close();
  });

  it("keeps running when both primary and fallback fail", async (t) => {
    const app = await build(t);

    const primary = "primary";
    const fallback = "fallback";
    const rounds: Array<{
      response: string | null;
      used?: string;
    }> = [];

    let done: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });

    const poller = app.poller.create({
      primary,
      fallback,
      fetchOne: async () => {
        throw new Error("boom");
      },
      onRound: (response, context) => {
        rounds.push({ response, used: context.used });
        if (context.round === 2) {
          queueMicrotask(() => {
            poller.stop().then(() => done?.(), noop);
          });
        }
      },
      intervalMs: 10,
      requestTimeoutMs: 20,
      jitterMs: 0,
    });

    poller.start();
    await completion;

    assert.deepStrictEqual(rounds, [
      { response: null, used: undefined },
      { response: null, used: undefined },
    ]);
  });
});
