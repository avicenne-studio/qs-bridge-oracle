import path from "node:path";
import fp from "fastify-plugin";
import { ReturnType } from "@sinclair/typebox";

declare module "fastify" {
  interface FastifyInstance {
    fileManager: ReturnType<typeof createFileManager>;
  }
}

function createFileManager() {
  return {
    sanitizeKeyFilePath,
  };
}

function sanitizeKeyFilePath(variableName: string, rawPath: string) {
  const normalized = path.normalize(rawPath);

  const hasTraversal = normalized
    .split(path.sep)
    .some((segment) => segment === "..");
  if (hasTraversal) {
    throw new Error(
      `${variableName} must not contain parent directory traversal`
    );
  }

  if (path.extname(normalized).toLowerCase() !== ".json") {
    throw new Error(`${variableName} must point to a JSON file`);
  }

  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(process.cwd(), normalized);
}

export default fp(
  async (fastify) => {
    fastify.decorate("fileManager", createFileManager());
  },
  { name: "file-manager" }
);
