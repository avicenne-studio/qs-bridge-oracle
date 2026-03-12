import process from "node:process";
import {
  QUBIC_BOB_URL,
  CONTRACT_INDEX,
  findLogs,
  fetchCurrentTick,
  logSection,
  parseArgs,
} from "./utils.js";

const EVENT_TYPE_NAMES = {
  1: "Lock",
  2: "OverrideLock",
  3: "Unlock",
  4: "CancelLock",
};

function decodeLogEntry(entry) {

  const typeName = EVENT_TYPE_NAMES[entry.eventType] ?? `unknown(${entry.eventType})`;
  return {
    ...entry,
    _decodedType: typeName,
    _note: "BLOCKED (S3): Raw entry shown as-is — layout unconfirmed",
  };
}

// OK: Bob Node exposes /status. BLOCKED: we don't parse it yet; using env fallback.
const BOB_INITIAL_TICK = Number(process.env.BOB_INITIAL_TICK ?? "44700000");

async function main() {
  const args = parseArgs(process.argv, { startIndex: 2 });
  const windowSize = args.limit != null ? Number(args.limit) * 1000 : 50000;
  const fromTickArg = args["from-tick"] != null ? Number(args["from-tick"]) : null;

  logSection("poll-events", `Bob Node: ${QUBIC_BOB_URL}, contract index: ${CONTRACT_INDEX}`);

  // OK: use Qubic RPC /tick-info to compute toTick when available.
  let currentTick;
  try {
    currentTick = await fetchCurrentTick();
    process.stdout.write(`Current tick: ${currentTick}\n`);
  } catch (err) {
    process.stderr.write(`Warning: could not fetch current tick (${err?.message})\n`);
  }

  const toTick = currentTick ?? BOB_INITIAL_TICK + windowSize;
  const fromTick = fromTickArg ?? Math.max(BOB_INITIAL_TICK, toTick - windowSize);

  logSection("poll-events", `Querying ticks ${fromTick} → ${toTick}`);

  const logs = await findLogs({
    scIndex: CONTRACT_INDEX,
    fromTick,
    toTick,
    logType: 0,   // 0 = all event types
    topic1: "",
    topic2: "",
    topic3: "",
  });

  logSection("poll-events", `Raw response (${Array.isArray(logs) ? logs.length : "?"} entries)`);
  process.stdout.write(JSON.stringify(logs, null, 2) + "\n");

  if (Array.isArray(logs) && logs.length > 0) {
    logSection("poll-events", "Decoded entries");
    for (const entry of logs) {
      const decoded = decodeLogEntry(entry);
      process.stdout.write(JSON.stringify(decoded, null, 2) + "\n");
    }

    const possibleIdFields = ["id", "_id", "logId", "eventId", "index"];
    for (const field of possibleIdFields) {
      if (logs[0]?.[field] != null) {
        process.stdout.write(
          `\n[S4 hint] Found potential unique ID field: "${field}" = ${logs[0][field]}\n`
        );
        break;
      }
    }
  } else if (Array.isArray(logs) && logs.length === 0) {
    process.stdout.write("No events found for this contract index.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
