import "./setup-env.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import redisConnection from "../src/utils/email.redis.js";
import { reserveSendCapacity } from "../src/utils/rate-limiter.js";

import {
  cleanupRlKeys,
  redisNowMs,
  rlKeys,
} from "./helpers/redis.js";

const MIN_INTERVAL_MS = 5000; // short, test-only spacing interval

function newUserId(): number {
  return 8_000_000 + Math.floor(Math.random() * 1_000_000);
}

after(async () => {
  await redisConnection.quit();
});

test("C1: sender spacing allows only 1 of 20 concurrent sends", async () => {
  const userId = newUserId();
  const senderId = `c1-sender-${userId}`;
  await cleanupRlKeys(redisConnection, userId);

  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      reserveSendCapacity({
        emailId: `c1-${i}`,
        userId,
        senderId,
        senderHourlyLimit: 1000, // must not bind
        tenantHourlyLimit: 1000,
        minIntervalMs: MIN_INTERVAL_MS,
      }),
    ),
  );

  const allowed = attempts.filter((r) => r.allowed).length;
  assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);

  const denials = attempts.filter((r) => !r.allowed);
  assert.equal(denials.length, 19);
  for (const d of denials) {
    if (d.allowed) continue;
    assert.equal(d.reason, "sender-spacing");
  }

  // Only the winner wrote a reservation; spacing does not consume quota.
  const { senderKey } = rlKeys(userId, senderId);
  assert.equal(await redisConnection.zcard(senderKey), 1);
});

test("C2: denial retryAt is exactly last-send + interval, and clears when aged", async () => {
  const userId = newUserId();
  const senderId = `c2-sender-${userId}`;
  await cleanupRlKeys(redisConnection, userId);

  const { senderKey, lastKey } = rlKeys(userId, senderId);

  // Seed a last-send timestamp at "now" so the next send must wait the full
  // interval. Deterministic: we drive the clock, we never sleep on it.
  const now = await redisNowMs(redisConnection);
  await redisConnection.set(lastKey, String(now));
  await redisConnection.expire(lastKey, 3600);

  const denied = await reserveSendCapacity({
    emailId: "c2-first",
    userId,
    senderId,
    senderHourlyLimit: 1000,
    tenantHourlyLimit: 1000,
    minIntervalMs: MIN_INTERVAL_MS,
  });

  assert.equal(denied.allowed, false);
  if (denied.allowed) return;
  assert.equal(denied.reason, "sender-spacing");
  assert.equal(
    denied.retryAt - now,
    MIN_INTERVAL_MS,
    `retryAt should be exactly last-send + ${MIN_INTERVAL_MS}ms`,
  );

  // Nothing was consumed while denied.
  assert.equal(await redisConnection.zcard(senderKey), 0);

  // Age the last-send back past the interval: the same email is now allowed.
  const aged = now - MIN_INTERVAL_MS - 1;
  await redisConnection.set(lastKey, String(aged));

  const allowed = await reserveSendCapacity({
    emailId: "c2-first",
    userId,
    senderId,
    senderHourlyLimit: 1000,
    tenantHourlyLimit: 1000,
    minIntervalMs: MIN_INTERVAL_MS,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(await redisConnection.zcard(senderKey), 1);
});

test("C3: spacing applies tenant-wide when the email has no sender (PC1)", async () => {
  const userId = newUserId();
  await cleanupRlKeys(redisConnection, userId);

  // No senderId at all: this is the API-batch path. Before the fix the
  // spacing check sat inside `if hasSender`, so every one of these was
  // allowed at once.
  const attempts = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      reserveSendCapacity({
        emailId: `c3-${i}`,
        userId,
        senderId: null,
        senderHourlyLimit: null,
        tenantHourlyLimit: 1000,
        minIntervalMs: MIN_INTERVAL_MS,
      }),
    ),
  );

  const allowed = attempts.filter((r) => r.allowed).length;
  assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);

  const denials = attempts.filter((r) => !r.allowed);
  assert.equal(denials.length, 9);
  for (const d of denials) {
    if (d.allowed) continue;
    assert.equal(d.reason, "sender-spacing");
  }

  // The tenant reservation set holds exactly 1, and lastKey was persisted
  // under the senderless ("-") key, which is what makes spacing tenant-wide.
  const { tenantKey, lastKey } = rlKeys(userId, null);
  assert.equal(await redisConnection.zcard(tenantKey), 1);
  assert.ok(
    (await redisConnection.get(lastKey)) !== null,
    "last-send timestamp must be persisted for senderless emails",
  );
});

test("C4: minIntervalMs = 0 disables spacing entirely", async () => {
  const userId = newUserId();
  const senderId = `c4-sender-${userId}`;
  await cleanupRlKeys(redisConnection, userId);

  const attempts = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      reserveSendCapacity({
        emailId: `c4-${i}`,
        userId,
        senderId,
        senderHourlyLimit: 1000,
        tenantHourlyLimit: 1000,
        minIntervalMs: 0,
      }),
    ),
  );

  assert.equal(attempts.filter((r) => r.allowed).length, 5);
});
