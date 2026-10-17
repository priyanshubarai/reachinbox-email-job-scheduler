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

function newUserId(): number {
  return 6_000_000 + Math.floor(Math.random() * 1_000_000);
}

after(async () => {
  await redisConnection.quit();
});

test("E1: rolling window eviction frees exactly one slot after oldest expires", async () => {
  const userId = newUserId();
  const senderId = `e1-sender-${userId}`;
  const windowMs = 5000;
  await cleanupRlKeys(redisConnection, userId);

  const a = await reserveSendCapacity({
    emailId: "e1-a",
    userId,
    senderId,
    senderHourlyLimit: 2,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(a.allowed, true);

  const b = await reserveSendCapacity({
    emailId: "e1-b",
    userId,
    senderId,
    senderHourlyLimit: 2,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(b.allowed, true);

  const c = await reserveSendCapacity({
    emailId: "e1-c",
    userId,
    senderId,
    senderHourlyLimit: 2,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(c.allowed, false);
  if (c.allowed) return;
  assert.equal(c.reason, "sender-hourly");

  // Get scores to locate the oldest.
  const { senderKey } = rlKeys(userId, senderId);
  const scores = await redisConnection.zmscore(senderKey, "e1-a", "e1-b", "e1-c");
  const scoreA = Number(scores[0]);
  const scoreB = Number(scores[1]);
  assert.notEqual(scoreA, null);
  assert.notEqual(scoreB, null);

  // Find oldest.
  const oldest = scoreA <= scoreB ? { id: "e1-a", s: scoreA } : { id: "e1-b", s: scoreB };
  const now = await redisNowMs(redisConnection);

  // Age oldest just past window.
  await redisConnection.zadd(senderKey, now - windowMs - 1, oldest.id);

  const c2 = await reserveSendCapacity({
    emailId: "e1-c",
    userId,
    senderId,
    senderHourlyLimit: 2,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(c2.allowed, true, "evicted oldest should free a slot for c");

  const card = await redisConnection.zcard(senderKey);
  assert.equal(card, 2);
});

test("E2: retryAt equals oldest reservation score plus window (rolling window)", async () => {
  const userId = newUserId();
  const senderId = `e2-sender-${userId}`;
  const windowMs = 3000;
  await cleanupRlKeys(redisConnection, userId);

  await reserveSendCapacity({
    emailId: "e2-a",
    userId,
    senderId,
    senderHourlyLimit: 1,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
    windowMs,
  });

  const denied = await reserveSendCapacity({
    emailId: "e2-b",
    userId,
    senderId,
    senderHourlyLimit: 1,
    tenantHourlyLimit: 1000,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(denied.allowed, false);
  if (denied.allowed) return;
  assert.equal(denied.reason, "sender-hourly");

  const { senderKey } = rlKeys(userId, senderId);
  const sA = await redisConnection.zscore(senderKey, "e2-a");
  assert.notEqual(sA, null);
  const expected = Number(sA) + windowMs;
  assert.equal(denied.retryAt, expected);
});
