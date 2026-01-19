import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import { Type } from "@sinclair/typebox";
import validationPlugin, {
  formatFirstError,
} from "../../../src/plugins/app/common/validation.js";
import {
  kValidation,
  type ValidationService,
} from "../../../src/plugins/app/common/validation.js";

describe("validation plugin", () => {
  it("uses fallback message when schema errors are empty", () => {
    const message = formatFirstError(Type.Unknown(), "value");
    assert.strictEqual(message, "Invalid schema");
  });

  it("throws with formatted error in assertValid", async () => {
    const app = fastify();
    await app.register(validationPlugin);
    await app.ready();
    const validation: ValidationService = app.getDecorator(kValidation);

    assert.throws(
      () =>
        validation.assertValid(Type.Number(), "not-a-number", "Validation"),
      /Validation: invalid schema -/
    );

    await app.close();
  });
});
