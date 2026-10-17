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

/** Unique tenant ids so this run can never collide with another. */
function newUserId(): number {
  return 9_000_000 + Math.floor(Math.random() * 1_000_000);
}

function newEmailId(prefix: string, n: number): string {
  return `${prefix}-${n}`;
}

after(async () => {
  await redisConnection.quit();
});

test("A: sender quota of 5 admits exactly 5 of 20 concurrent sends", async () => {
  const userId = newUserId();
  const senderId = `sender-${userId}`;
  const senderHourlyLimit = 5;
  const tenantHourlyLimit = 1000;

  await cleanupRlKeys(redisConnection, userId);

  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      reserveSendCapacity({
        emailId: newEmailId("a", i),
        userId,
        senderId,
        senderHourlyLimit,
        tenantHourlyLimit,
        minIntervalMs: 0,
      }),
    ),
  );

  const allowed = attempts.filter((r) => r.allowed).length;
  const denied = attempts.filter((r) => !r.allowed);

  assert.equal(allowed, 5, `expected exactly 5 allowed, got ${allowed}`);
  assert.equal(denied.length, 15);

  // Every denial is a real rate-limit denial carrying a future retry time.
  const now = await redisNowMs(redisConnection);
  for (const d of denied) {
    assert.equal(d.allowed, false);
    if (d.allowed) continue;
    assert.equal(d.reason, "sender-hourly");
    assert.ok(
      d.retryAt > now - 1000,
      `retryAt ${d.retryAt} should be a near-future server time (now ${now})`,
    );
  }

  // Redis state matches: exactly 5 reservations, tenant set shared.
  const { senderKey, tenantKey } = rlKeys(userId, senderId);
  assert.equal(await redisConnection.zcard(senderKey), 5);
  assert.equal(await redisConnection.zcard(tenantKey), 5);
});

test("B: tenant quota of 7 is shared across 2 senders under 20 concurrent sends", async () => {
  const userId = newUserId();
  const senderA = `sender-a-${userId}`;
  const senderB = `sender-b-${userId}`;
  const senderHourlyLimit = 100; // high: must never be the binding constraint
  const tenantHourlyLimit = 7;

  await cleanupRlKeys(redisConnection, userId);

  // Interleave A/B so neither sender can sweep all the early slots.
  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const senderId = i % 2 === 0 ? senderA : senderB;
      return reserveSendCapacity({
        emailId: newEmailId(`b-${i % 2 === 0 ? "a" : "b"}`, i),
        userId,
        senderId,
        senderHourlyLimit,
        tenantHourlyLimit,
        minIntervalMs: 0,
      });
    }),
  );

  const allowed = attempts.filter((r) => r.allowed).length;
  const denied = attempts.filter((r) => !r.allowed);

  assert.equal(allowed, 7, `expected exactly 7 allowed, got ${allowed}`);
  assert.equal(denied.length, 13);

  // Shared tenant set holds exactly 7, and both senders contributed.
  const { tenantKey } = rlKeys(userId, senderA);
  const { senderKey: senderAKey } = rlKeys(userId, senderA);
  const { senderKey: senderBKey } = rlKeys(userId, senderB);

  assert.equal(await redisConnection.zcard(tenantKey), 7);

  const aCount = await redisConnection.zcard(senderAKey);
  const bCount = await redisConnection.zcard(senderBKey);
  assert.equal(aCount + bCount, 7, "sender reservations must sum to tenant total");
  assert.ok(aCount >= 1, "sender A should have been admitted");
  assert.ok(bCount >= 1, "sender B should have been admitted");

  // Denials are tenant-scoped (the sender quota was never reached).
  for (const d of denied) {
    assert.equal(d.allowed, false);
    if (d.allowed) continue;
    assert.equal(d.reason, "tenant-hourly");
  }
});

