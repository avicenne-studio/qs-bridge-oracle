import type { EnvConfig } from "../../infra/env.js";
import type { UndiciClientService } from "../../infra/undici-client.js";
import type { OracleOrder } from "../indexer/schemas/order.js";

type RelayResult = { trxHash: string };

function buildUnlockPath(rpcUrl: string): { origin: string; path: string } {
  const url = new URL(rpcUrl);
  const origin = url.origin;
  const basePath = url.pathname === "/" ? "" : url.pathname;
  return { origin, path: `${basePath}/unlock` };
}

function buildUnlockPayload(order: OracleOrder) {
  return {
    to: order.to,
    amount: order.amount,
    nonce: order.source_nonce,
  };
}

export async function relayToQubic(
  order: OracleOrder,
  deps: { config: EnvConfig; client: ReturnType<UndiciClientService["create"]> }
): Promise<RelayResult> {
  const { origin, path } = buildUnlockPath(deps.config.QUBIC_RPC_URL);
  const payload = buildUnlockPayload(order);
  const body = await deps.client.postJson<{ trxHash?: string }>(
    origin,
    path,
    payload
  );
  if (!body.trxHash) {
    throw new Error("Relay response missing trxHash");
  }

  return { trxHash: body.trxHash };
}
