import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

declare module "fastify" {
  interface FastifyInstance {
    validation: {
      isValid<T>(schema: TSchema, value: unknown): value is T;
      assertValid<T>(schema: TSchema, value: unknown, prefix: string): asserts value is T;
    };
  }
}

export function formatFirstError(schema: TSchema, value: unknown) {
  for (const error of Value.Errors(schema, value)) {
    return `${error.message} at ${error.path}`;
  }
  return "Invalid schema";
}

function createValidation() {
  return {
    isValid<T>(schema: TSchema, value: unknown): value is T {
      return Value.Check(schema, value);
    },
    assertValid<T>(schema: TSchema, value: unknown, prefix: string): asserts value is T {
      if (!Value.Check(schema, value)) {
        const errorMessage = formatFirstError(schema, value);
        throw new Error(`${prefix}: invalid schema - ${errorMessage}`);
      }
    },
  };
}

export default fp(
  async function validationPlugin(fastify: FastifyInstance) {
    fastify.decorate("validation", createValidation());
  },
  { name: "validation" }
);
