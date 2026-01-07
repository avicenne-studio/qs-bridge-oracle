import { it } from "node:test";
import assert from "node:assert";
import { build } from "../helper.js";

it("should call errorHandler", async (t) => {
  const app = await build(t, (instance) => {
    instance.get("/error", () => {
      throw new Error("Kaboom!");
    });
  });

  const res = await app.inject({
    method: "GET",
    url: "/error",
  });

  assert.deepStrictEqual(JSON.parse(res.payload), {
    message: "Internal Server Error",
  });
});
