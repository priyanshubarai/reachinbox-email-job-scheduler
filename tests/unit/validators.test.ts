import "../setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBatchSchema,
  listBatchesQuerySchema,
  MAX_RECIPIENTS,
} from "../../src/validators/batch.validator.js";
import { listEmailsQuerySchema } from "../../src/validators/email.validator.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../../src/validators/common.validator.js";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function base() {
  return {
    senderId: "11111111-1111-4111-8111-111111111111",
    subject: "Hello",
    body: "Body",
    startAt: FUTURE,
    delayMs: 1000,
    hourlyLimit: 100,
    recipients: ["alice@example.com"],
  };
}

test("accepts a minimal valid payload and normalizes recipients", () => {
  const parsed = createBatchSchema.safeParse(base());
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.recipients, [{ email: "alice@example.com", name: null }]);
  }
});

test("accepts object recipients and trims the name", () => {
  const parsed = createBatchSchema.safeParse({
    ...base(),
    recipients: [{ email: "Alice@Example.com", name: "  Alice  " }],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.deepEqual(parsed.data.recipients, [{ email: "alice@example.com", name: "Alice" }]);
  }
});

test("rejects an invalid sender uuid", () => {
  assert.equal(createBatchSchema.safeParse({ ...base(), senderId: "nope" }).success, false);
});

test("rejects an invalid recipient address", () => {
  assert.equal(
    createBatchSchema.safeParse({ ...base(), recipients: ["not-an-email"] }).success,
    false,
  );
});

test("rejects duplicate recipients", () => {
  const result = createBatchSchema.safeParse({
    ...base(),
    recipients: ["a@x.com", "A@X.com"],
  });
  assert.equal(result.success, false);
});

test("rejects an empty recipient list", () => {
  assert.equal(createBatchSchema.safeParse({ ...base(), recipients: [] }).success, false);
});

test("rejects too many recipients", () => {
  const recipients = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `r${i}@x.com`);
  assert.equal(createBatchSchema.safeParse({ ...base(), recipients }).success, false);
});

test("rejects a start time in the past", () => {
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(createBatchSchema.safeParse({ ...base(), startAt: past }).success, false);
});

test("rejects an invalid start time", () => {
  assert.equal(createBatchSchema.safeParse({ ...base(), startAt: "soon" }).success, false);
});

test("rejects out-of-range numeric limits", () => {
  assert.equal(createBatchSchema.safeParse({ ...base(), delayMs: -1 }).success, false);
  assert.equal(createBatchSchema.safeParse({ ...base(), hourlyLimit: 0 }).success, false);
  assert.equal(createBatchSchema.safeParse({ ...base(), hourlyLimit: 1e9 }).success, false);
  assert.equal(createBatchSchema.safeParse({ ...base(), delayMs: 1.5 }).success, false);
});

test("rejects an invalid explicit idempotency key", () => {
  assert.equal(
    createBatchSchema.safeParse({ ...base(), idempotencyKey: "has spaces" }).success,
    false,
  );
});

test("pagination defaults and bounds", () => {
  const parsed = listBatchesQuerySchema.safeParse({});
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.page, 1);
    assert.equal(parsed.data.limit, DEFAULT_LIMIT);
  }

  assert.equal(listBatchesQuerySchema.safeParse({ limit: String(MAX_LIMIT + 1) }).success, false);
  assert.equal(listBatchesQuerySchema.safeParse({ page: "0" }).success, false);
  assert.equal(listBatchesQuerySchema.safeParse({ page: "abc" }).success, false);
  assert.equal(listBatchesQuerySchema.safeParse({ senderId: "x" }).success, false);
});

test("email query validates status enum and recipient", () => {
  assert.equal(listEmailsQuerySchema.safeParse({ status: "sent" }).success, true);
  assert.equal(listEmailsQuerySchema.safeParse({ status: "bogus" }).success, false);
  assert.equal(listEmailsQuerySchema.safeParse({ recipient: "a@x.com" }).success, true);
  assert.equal(listEmailsQuerySchema.safeParse({ recipient: "nope" }).success, false);
});
