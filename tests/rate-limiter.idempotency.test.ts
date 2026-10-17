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
  return 7_000_000 + Math.floor(Math.random() * 1_000_000);
}

after(async () => {
  await redisConnection.quit();
});

test("D1: identical emailId calls are idempotent (counts unchanged)", async () => {
  const userId = newUserId();
  const senderId = `d1-sender-${userId}`;
  await cleanupRlKeys(redisConnection, userId);

  const first = await reserveSendCapacity({
    emailId: "d1-x",
    userId,
    senderId,
    senderHourlyLimit: 5,
    tenantHourlyLimit: 100,
    minIntervalMs: 0,
  });
  assert.equal(first.allowed, true);

  for (let i = 0; i < 4; i++) {
    const r = await reserveSendCapacity({
      emailId: "d1-x",
      userId,
      senderId,
      senderHourlyLimit: 5,
      tenantHourlyLimit: 100,
      minIntervalMs: 0,
    });
    assert.equal(r.allowed, true);
  }

  const { senderKey, tenantKey } = rlKeys(userId, senderId);
  assert.equal(await redisConnection.zcard(senderKey), 1);
  assert.equal(await redisConnection.zcard(tenantKey), 1);
});

test("D2: reservations expire and can be re-reserved for the same emailId", async () => {
  const userId = newUserId();
  const senderId = `d2-sender-${userId}`;
  const windowMs = 1000;
  await cleanupRlKeys(redisConnection, userId);

  const first = await reserveSendCapacity({
    emailId: "d2-x",
    userId,
    senderId,
    senderHourlyLimit: 10,
    tenantHourlyLimit: 100,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(first.allowed, true);

  // Age the reservation past the window.
  const now = await redisNowMs(redisConnection);
  const { senderKey, tenantKey } = rlKeys(userId, senderId);
  await redisConnection.zadd(senderKey, now - windowMs - 50, "d2-x");
  await redisConnection.zadd(tenantKey, now - windowMs - 50, "d2-x");

  const second = await reserveSendCapacity({
    emailId: "d2-x",
    userId,
    senderId,
    senderHourlyLimit: 10,
    tenantHourlyLimit: 100,
    minIntervalMs: 0,
    windowMs,
  });
  assert.equal(second.allowed, true);

  const freshScore = await redisConnection.zscore(senderKey, "d2-x");
  assert.notEqual(freshScore, null);
  const fs = Number(freshScore);
  assert.ok(fs > now - 200, "score should be fresh after re-reservation");
});

test("D3: idempotent call returns allowed true even under denied state (same emailId)", async () => {
  const userId = newUserId();
  const senderId = `d3-sender-${userId}`;
  await cleanupRlKeys(redisConnection, userId);

  const { senderKey, tenantKey } = rlKeys(userId, senderId);
  const now = await redisNowMs(redisConnection);
  await redisConnection.zadd(senderKey, now, "other1");
  await redisConnection.zadd(senderKey, now, "other2");
  await redisConnection.zadd(tenantKey, now, "other1");
  await redisConnection.zadd(tenantKey, now, "other2");
  await redisConnection.zadd(senderKey, now, "d3-x");
  await redisConnection.zadd(tenantKey, now, "d3-x");

  const r = await reserveSendCapacity({
    emailId: "d3-x",
    userId,
    senderId,
    senderHourlyLimit: 2,
    tenantHourlyLimit: 100,
    minIntervalMs: 0,
  });
  // Idempotent call: email already reserved returns allowed=true.
  assert.equal(r.allowed, true);
});
