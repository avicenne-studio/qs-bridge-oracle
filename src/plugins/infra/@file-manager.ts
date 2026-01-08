import fs from "node:fs/promises";
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
    readJsonFile,
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

async function readJsonFile(prefix: string, filePath: string) {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`${prefix}: file not found at ${filePath}`);
    }
    throw new Error(`${prefix}: unable to read file - ${err.message}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${prefix}: file does not contain valid JSON`);
  }
}

export default fp(
  async (fastify) => {
    fastify.decorate("fileManager", createFileManager());
  },
  { name: "file-manager" }
);
