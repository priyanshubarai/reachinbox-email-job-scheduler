import { test, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("./dep.js", { namedExports: { value: "mocked" } });

test("mock.module intercepts a tsx-resolved .js specifier", async () => {
  const { value } = await import("./dep.js");
  assert.equal(value, "mocked");
});
