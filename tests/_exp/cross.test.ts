import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const targetUrl = pathToFileURL(resolve(here, "mock-src.js")).href;

mock.module(targetUrl, { namedExports: { value: "mocked" } });

test("mock.module by absolute URL intercepts a consumer's static import", async () => {
  const { seen } = await import("./nested/fake-consumer.js");
  assert.equal(seen, "mocked");
});
