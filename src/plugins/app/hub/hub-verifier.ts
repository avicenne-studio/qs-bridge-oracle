import { createHash, createPublicKey, verify } from "node:crypto";
import fp from "fastify-plugin";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Static, Type } from "@sinclair/typebox";
import { kHubKeys, type HubKeysFile } from "./hub-keys.js";
import {
  kHubNoncesRepository,
  type HubNoncesRepository,
} from "./hub-nonces.repository.js";
import { kValidation, type ValidationService } from "../../infra/validation.js";

export const HUB_AUTH_TIME_SKEW_SECONDS = 60;
export const HUB_NONCE_CLEANUP_INTERVAL_MS = 2 * 60 * 1000;
export const HUB_NONCE_CLEANUP_BUFFER_SECONDS = 30;

const EMPTY_BODY_HASH = createHash("sha256").update("").digest("hex");

const HubHeadersSchema = Type.Object({
  "x-hub-id": Type.String({ minLength: 1 }),
  "x-key-id": Type.String({ minLength: 1 }),
  "x-timestamp": Type.String({ minLength: 1, pattern: "^[0-9]+$" }),
  "x-nonce": Type.String({ minLength: 1 }),
  "x-body-hash": Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64 }),
  "x-signature": Type.String({ minLength: 1 }),
});

type HubHeaders = Static<typeof HubHeadersSchema>;

function shouldVerify(request: FastifyRequest) {
  return request.url.startsWith("/api/");
}

function sendUnauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: string
) {
  request.log.warn({ reason }, "Unauthorized hub request");
  reply.code(401).send({ message: "Unauthorized" });
}

// for later with-body request
// TODO: to remove if no such request received in the final implementation
function hashBody() {
  return EMPTY_BODY_HASH;
}

export function buildCanonicalString(input: {
  method: string;
  url: string;
  hubId: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return (
    [
      input.method.toUpperCase(),
      input.url,
      `hubId=${input.hubId}`,
      `timestamp=${input.timestamp}`,
      `nonce=${input.nonce}`,
      `bodyhash=${input.bodyHash}`,
    ].join("\n") + "\n"
  );
}

function getHubPublicKey(hubKeys: HubKeysFile, hubId: string, kid: string) {
  const hub = hubKeys[hubId as keyof HubKeysFile];
  if (!hub) {
    return null;
  }
  if (hub.current.kid === kid) {
    return hub.current.publicKeyPem;
  }
  if (hub.next.kid === kid) {
    return hub.next.publicKeyPem;
  }
  return null;
}

export default fp(
  async function hubVerifierPlugin(fastify: FastifyInstance) {
    const validation = fastify.getDecorator<ValidationService>(kValidation);
    const hubNoncesRepository =
      fastify.getDecorator<HubNoncesRepository>(kHubNoncesRepository);
    const hubKeys = fastify.getDecorator<HubKeysFile>(kHubKeys);

    fastify.addHook("preValidation", async (request, reply) => {
      if (!shouldVerify(request)) {
        return;
      }

      const headers = {
        "x-hub-id": request.headers["x-hub-id"],
        "x-key-id": request.headers["x-key-id"],
        "x-timestamp": request.headers["x-timestamp"],
        "x-nonce": request.headers["x-nonce"],
        "x-body-hash": request.headers["x-body-hash"],
        "x-signature": request.headers["x-signature"],
      };

      if (!validation.isValid<HubHeaders>(HubHeadersSchema, headers)) {
        return sendUnauthorized(request, reply, "invalid-headers");
      }

      const hubId = headers["x-hub-id"];
      const kid = headers["x-key-id"];
      const timestampRaw = headers["x-timestamp"];
      const nonce = headers["x-nonce"];
      const bodyHashHeader = headers["x-body-hash"];
      const signature = headers["x-signature"];

      const timestamp = parseInt(timestampRaw, 10);

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - timestamp) > HUB_AUTH_TIME_SKEW_SECONDS) {
        return sendUnauthorized(request, reply, "timestamp-skew");
      }

      const exists = await hubNoncesRepository.exists(
        hubId,
        kid,
        nonce
      );
      if (exists) {
        return sendUnauthorized(request, reply, "nonce-replay");
      }

      try {
        await hubNoncesRepository.insert({
          hubId,
          kid,
          nonce,
          ts: timestamp,
        });
      } catch (error) {
        request.log.warn({ err: error }, "Failed to store hub nonce");
        return sendUnauthorized(request, reply, "nonce-store-failed");
      }

      const bodyHash = hashBody();
      if (bodyHash !== bodyHashHeader) {
        return sendUnauthorized(request, reply, "body-hash-mismatch");
      }

      const url = request.url;
      const canonical = buildCanonicalString({
        method: request.method,
        url,
        hubId,
        timestamp: timestamp.toString(),
        nonce,
        bodyHash,
      });

      const publicKeyPem = getHubPublicKey(hubKeys, hubId, kid);
      if (!publicKeyPem) {
        return sendUnauthorized(request, reply, "unknown-key");
      }

      const publicKey = createPublicKey(publicKeyPem);
      const signatureOk = verify(
        null,
        Buffer.from(canonical),
        publicKey,
        Buffer.from(signature, "base64")
      );

      if (!signatureOk) {
        return sendUnauthorized(request, reply, "invalid-signature");
      }
    });
  },
  {
    name: "hub-verifier",
    dependencies: ["hub-keys", "hub-nonces-repository", "validation"],
  }
);
