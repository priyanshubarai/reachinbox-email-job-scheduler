import type { Redis } from "ioredis";

/**
 * Key names must stay byte-identical to `src/utils/rate-limiter.ts` (the Lua
 * script builds them from this exact hash-tag layout).
 */
export function rlKeys(userId: number | string, senderId: string | null) {
  const tag = `{u:${userId}}`;
  const sender = senderId ?? "-";
  return {
    senderKey: `rl:${tag}:sender:${sender}:res`,
    tenantKey: `rl:${tag}:tenant:res`,
    lastKey: `rl:${tag}:sender:${sender}:last`,
    scanPattern: `rl:${tag}:*`,
  };
}

/** Deletes only the limiter keys belonging to one test user. */
export async function cleanupRlKeys(
  redis: Redis,
  userId: number | string,
): Promise<number> {
  const pattern = rlKeys(userId, null).scanPattern;
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    keys.push(...found);
  } while (cursor !== "0");
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  return keys.length;
}

/** Authoritative server time (the same clock the Lua script reads). */
export async function redisNowMs(redis: Redis): Promise<number> {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

/** Moves a reservation's score so the rolling window treats it as older. */
export async function ageZsetMember(
  redis: Redis,
  key: string,
  member: string,
  scoreMs: number,
): Promise<void> {
  await redis.zadd(key, scoreMs, member);
}

/** Polls `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms while waiting for: ${label} ` +
          `(last=${String(last)})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function ageLastKey(
  redis: Redis,
  key: string,
  scoreMs: number,
): Promise<void> {
  await redis.set(key, String(scoreMs));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
