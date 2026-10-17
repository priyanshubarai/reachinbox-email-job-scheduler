import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { createApp } from "../../src/app.js";

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Starts the real Express app on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const server: Server = app.listen(0);
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Switches the development identity used by `requireAuth`. */
export function actAs(userId: number): void {
  process.env.AUTH_DEV_USER_ID = String(userId);
}

/** Removes the development identity so requests are unauthenticated. */
export function actAsNobody(): void {
  delete process.env.AUTH_DEV_USER_ID;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** Thin JSON request helper over the global fetch. */
export async function api<T = unknown>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);

  return { status: response.status, body, headers: response.headers };
}

/** A valid batch payload builder with sensible defaults. */
export function validBatchPayload(senderId: string, overrides: Record<string, unknown> = {}) {
  return {
    senderId,
    subject: "Hello {{name}}",
    body: "Hi {{name}}, your address is {{email}}.",
    startAt: new Date(Date.now() + 60_000).toISOString(),
    delayMs: 1000,
    hourlyLimit: 100,
    recipients: [
      { email: "alice@example.com", name: "Alice" },
      { email: "bob@example.com", name: "Bob" },
    ],
    ...overrides,
  };
}

/**
 * Returns every BullMQ key for the email queue in the test Redis database.
 *
 * Mirrors `EMAIL_QUEUE_NAME` from `src/queue/email.queue.ts` ("email-sending").
 * Returns `null` when Redis is unreachable so the caller can skip rather than
 * fail on an environment that has no Redis.
 *
 * Note: merely constructing a BullMQ `Queue`/`Worker` creates the queue-level
 * keys `bull:email-sending:meta`, `:id` and `:marker` in whatever Redis database
 * it connects to. Other suites in the same run (for example the worker tests)
 * therefore leave keys behind, so "no keys at all" is NOT a valid signal that
 * the API published nothing. Callers must instead assert the absence of a job
 * key for the specific email ids under test (job ids are the email ids).
 */
export async function getEmailQueueKeys(): Promise<string[] | null> {
  const url = process.env.REDIS_URL;

  if (!url) {
    return null;
  }

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    return await client.keys("bull:email-sending:*");
  } catch {
    return null;
  } finally {
    client.disconnect();
  }
}

/**
 * Asserts the API never published a BullMQ job for `emailIds`.
 *
 * The outbox dispatcher is the only component allowed to call `emailQueue.add`,
 * and it uses `jobId = email.id`, so a leaked job shows up as a key containing
 * that email id. Returns the offending keys (empty when the API behaved), or
 * `null` when Redis is unreachable.
 */
export async function findQueueJobsForEmails(
  emailIds: string[],
): Promise<string[] | null> {
  const keys = await getEmailQueueKeys();
  if (keys === null) {
    return null;
  }
  return keys.filter((key) => emailIds.some((id) => key.includes(id)));
}
