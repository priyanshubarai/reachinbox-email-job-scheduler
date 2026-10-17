import redisConnection from "./email.redis.js";

export type RateLimitDenialReason =
  | "sender-hourly"
  | "tenant-hourly"
  | "sender-spacing";

export type RateLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      retryAt: number;
      reason: RateLimitDenialReason;
      serverNow: number;
    };

export interface ReserveSendCapacityInput {
  emailId: string;
  userId: number;
  /**
   * Sender scope. Omit (or pass null) when the email has no sender configured;
   * only the tenant quota is then enforced.
   */
  senderId?: string | null;
  /** Sender hourly quota. Required together with `senderId` for sender checks. */
  senderHourlyLimit?: number | null;
  tenantHourlyLimit: number;
  minIntervalMs: number;
  /** Sliding window length. Defaults to 60 minutes; overridable for tests. */
  windowMs?: number;
}

/** Sliding window: reservations older than this are dropped. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

const DENIAL_REASONS: readonly RateLimitDenialReason[] = [
  "sender-hourly",
  "tenant-hourly",
  "sender-spacing",
];

function isDenialReason(value: unknown): value is RateLimitDenialReason {
  return (
    typeof value === "string" &&
    (DENIAL_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Keys are hash-tagged with the USER id. The tenant key must be shared across
 * all of a user's senders (that is what "user quota" means), and the user id is
 * the one value common to all three keys — so putting it in the hash tag keeps
 * every key in the same Redis Cluster slot while the sender remains part of the
 * key name.
 */
function keysFor(senderId: string | null, userId: number) {
  const tag = `{u:${userId}}`;
  const sender = senderId ?? "-";
  return {
    senderKey: `rl:${tag}:sender:${sender}:res`,
    tenantKey: `rl:${tag}:tenant:res`,
    lastKey: `rl:${tag}:sender:${sender}:last`,
  };
}

/**
 * KEYS[1] sender reservations zset
 * KEYS[2] tenant reservations zset
 * KEYS[3] sender last-reservation string
 *
 * ARGV[1] emailId
 * ARGV[2] senderHourlyLimit  (0 / unused when ARGV[7] != "1")
 * ARGV[3] tenantHourlyLimit
 * ARGV[4] minIntervalMs
 * ARGV[5] windowMs
 * ARGV[6] keyTtlSeconds
 * ARGV[7] hasSender ("1" | "0")
 *
 * Returns { allowed(0|1), retryAtMs, reason, serverNowMs }
 */
const RESERVE_SEND_CAPACITY_LUA = `
local senderKey = KEYS[1]
local tenantKey = KEYS[2]
local lastKey   = KEYS[3]

local emailId       = ARGV[1]
local senderLimit   = tonumber(ARGV[2])
local tenantLimit   = tonumber(ARGV[3])
local minInterval   = tonumber(ARGV[4])
local window        = tonumber(ARGV[5])
local ttl           = tonumber(ARGV[6])
local hasSender     = ARGV[7] == '1'

-- Redis server time is the single clock for every worker.
local t = redis.call('TIME')
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
local cutoff = now - window

-- 1. Drop reservations that have aged out of the sliding window.
if hasSender then
  redis.call('ZREMRANGEBYSCORE', senderKey, '-inf', cutoff)
end
redis.call('ZREMRANGEBYSCORE', tenantKey, '-inf', cutoff)

-- 6. Idempotency: this email is already reserved and still inside the window.
if hasSender and redis.call('ZSCORE', senderKey, emailId) then
  return {1, 0, 'idempotent', now}
end
if redis.call('ZSCORE', tenantKey, emailId) then
  return {1, 0, 'idempotent', now}
end

local retryAt = 0
local reason = ''

-- Returns the time at which the (need)-th oldest reservation ages out.
local function slotFreeAt(key, count, limit)
  if limit <= 0 then
    return 0
  end
  if count < limit then
    return 0
  end
  local need = count - limit + 1
  local range = redis.call('ZRANGE', key, need - 1, need - 1, 'WITHSCORES')
  if #range == 0 then
    return 0
  end
  return math.floor(tonumber(range[2]) + window)
end

-- 2a. Sender hourly quota.
if hasSender then
  local senderCount = redis.call('ZCARD', senderKey)
  local at = slotFreeAt(senderKey, senderCount, senderLimit)
  if at > retryAt then
    retryAt = at
    reason = 'sender-hourly'
  end
end

-- 2b. Tenant (user) hourly quota.
local tenantCount = redis.call('ZCARD', tenantKey)
local tenantAt = slotFreeAt(tenantKey, tenantCount, tenantLimit)
if tenantAt > retryAt then
  retryAt = tenantAt
  reason = 'tenant-hourly'
end

-- 3. Sender minimum interval between sends.
if hasSender then
  local last = tonumber(redis.call('GET', lastKey) or '0')
  if last > 0 then
    local spacingAt = last + minInterval
    if spacingAt > now and spacingAt > retryAt then
      retryAt = spacingAt
      reason = 'sender-spacing'
    end
  end
end

-- 4. Denied: report when capacity frees up and consume nothing.
if retryAt > now then
  return {0, retryAt, reason, now}
end

-- 5. Allowed: record the reservation in both sets and the sender timestamp.
if hasSender then
  redis.call('ZADD', senderKey, now, emailId)
  redis.call('SET', lastKey, now)
  redis.call('EXPIRE', senderKey, ttl)
  redis.call('EXPIRE', lastKey, ttl)
end
redis.call('ZADD', tenantKey, now, emailId)
redis.call('EXPIRE', tenantKey, ttl)

return {1, 0, 'reserved', now}
`;

/**
 * Attempts to reserve one send slot for `emailId`.
 *
 * Resolves to `{ allowed: true }` when the caller may proceed (a fresh slot was
 * reserved, or the reservation already existed for this email). Resolves to a
 * denial carrying `retryAt` (absolute Redis time) otherwise.
 */
export async function reserveSendCapacity(
  input: ReserveSendCapacityInput,
): Promise<RateLimitResult> {
  const {
    emailId,
    userId,
    senderId = null,
    senderHourlyLimit = null,
    tenantHourlyLimit,
    minIntervalMs,
    windowMs = DEFAULT_WINDOW_MS,
  } = input;

  const window = windowMs > 0 ? Math.floor(windowMs) : DEFAULT_WINDOW_MS;
  const interval = minIntervalMs > 0 ? Math.floor(minIntervalMs) : 0;

  const hasSender =
    typeof senderId === "string" &&
    senderId.length > 0 &&
    typeof senderHourlyLimit === "number" &&
    senderHourlyLimit > 0;

  const { senderKey, tenantKey, lastKey } = keysFor(
    typeof senderId === "string" && senderId.length > 0 ? senderId : null,
    userId,
  );

  // Keep the keys alive across the window plus any spacing interval.
  const keyTtlSeconds = Math.ceil((window + interval) / 1000) + 60;

  const raw = (await redisConnection.eval(
    RESERVE_SEND_CAPACITY_LUA,
    3,
    senderKey,
    tenantKey,
    lastKey,
    emailId,
    String(hasSender ? senderHourlyLimit : 0),
    String(tenantHourlyLimit),
    String(interval),
    String(window),
    String(keyTtlSeconds),
    hasSender ? "1" : "0",
  )) as [number, number, string, number];

  if (Number(raw[0]) === 1) {
    return { allowed: true };
  }

  const retryAt = Number(raw[1]) > 0 ? Number(raw[1]) : 0;
  const serverNow = Number(raw[3]) > 0 ? Number(raw[3]) : Date.now();
  const reason = isDenialReason(raw[2]) ? raw[2] : "sender-hourly";

  return { allowed: false, retryAt, reason, serverNow };
}
