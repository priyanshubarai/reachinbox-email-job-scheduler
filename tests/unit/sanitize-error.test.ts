import "../setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeErrorText } from "../../src/utils/sanitize-error.js";

test("returns null for empty input", () => {
  assert.equal(sanitizeErrorText(null), null);
  assert.equal(sanitizeErrorText(undefined), null);
  assert.equal(sanitizeErrorText("   "), null);
});

test("collapses whitespace", () => {
  assert.equal(sanitizeErrorText("line1\n   line2"), "line1 line2");
});

test("redacts credential-looking material", () => {
  const result = sanitizeErrorText("535 auth failed password=hunter2");
  assert.ok(result);
  assert.ok(!result.includes("hunter2"), `should not leak secret: ${result}`);
  assert.ok(result.includes("[redacted]"));
});

test("truncates long messages", () => {
  const result = sanitizeErrorText("x".repeat(1000));
  assert.ok(result);
  assert.ok(result.length <= 300, `expected <= 300 chars, got ${result.length}`);
});
