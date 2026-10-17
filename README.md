# ReachInbox — Backend

Reliable, restart-safe email scheduling service built with **Express**, **BullMQ +
Redis**, **PostgreSQL (Drizzle ORM)** and **Ethereal SMTP**.

## Requirements

- Node.js 20+
- A PostgreSQL database (Neon-compatible)
- Redis (local or hosted)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in real values
```

### Environment

See [`.env.example`](./.env.example) for every supported variable. The most
important ones:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `development` or `production` (drives log formatting/defaults) |
| `PORT` | HTTP port (default `3000`) |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `ETHEREAL_HOST` / `ETHEREAL_PORT` / `ETHEREAL_USER` / `ETHEREAL_PASS` | Ethereal SMTP credentials |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency (default `2`) |
| `SENDER_MIN_INTERVAL_MS` | Minimum spacing between two sends by the same sender, in ms (`0` = disabled) |
| `LOG_LEVEL` | Minimum log level (see below) |
| `AUTH_DEV_USER_ID` | Development/test identity only (see [Authentication](#authentication-integration-point)); ignored in production |

## Scripts

```bash
pnpm run dev        # start the HTTP server with hot reload (tsx watch)
pnpm run worker     # start the worker + outbox dispatcher
pnpm run build      # compile TypeScript to dist/
pnpm start          # run the compiled server (node dist/app.js)
pnpm run lint       # ESLint
pnpm test           # every test suite (node:test via tsx, serialized)
pnpm run test:unit         # rate-limiter suites (Redis)
pnpm run test:integration  # worker suites (mocked mailer)
pnpm run db:push    # push the Drizzle schema
pnpm run db:generate    # generate a migration from the schema
pnpm run db:migrate     # apply pending migrations
pnpm run db:seed:test   # seed development fixtures (safety-gated)
```

Run the **server** (`pnpm run dev`) and the **worker** (`pnpm run worker`) in
separate terminals.

## Logging

Logging is centralized in **Winston** (`src/lib/logger.ts`) for application logs
and **Morgan** (`src/middleware/http-logger.ts`) for HTTP access logs. Morgan
output is forwarded into Winston at the `http` level, so every line goes through
one backend and one format.

### Levels and `LOG_LEVEL`

Levels, ordered from least to most verbose:

| Level | Used for |
| --- | --- |
| `error` | Failures requiring attention (exceptions, SMTP/DB/dispatch errors) |
| `warn` | Recoverable problems (retries, rejected requests, Redis reconnects) |
| `http` | One line per HTTP request (Morgan) |
| `info` | Lifecycle events (startup/shutdown, email sent, batch scheduled) |
| `debug` | Verbose diagnostics (dispatch cycles, skips) |

`LOG_LEVEL` sets the minimum severity that is emitted **and everything above
it**. Unset, it defaults to **`debug` in development** and **`info` in
production**. `http` is intentionally more severe than `info` so that the
production default still emits HTTP access logs while hiding `debug`. Invalid
values are ignored and the default is used.

### Development vs production formatting

- **Development** (`NODE_ENV !== "production"`): human-readable, timestamped
  single lines. Colors are applied only when stdout is a TTY.
  `2026-01-01 12:00:00.000 info [8f0c…] HTTP server listening {"port":3000}`
- **Production**: one JSON object per line, suitable for container stdout/stderr
  and log aggregators. Includes `timestamp`, `level`, `message`, `service`, and
  `requestId` when available.

Logs go to **stdout**; `error`-level logs go to **stderr**. No file transports
are configured — containers should collect the streams.

### Request correlation

- `src/middleware/request-id.ts` assigns every request an ID: a well-formed
  client `X-Request-ID` (`^[A-Za-z0-9._-]{1,128}$`) is reused, otherwise a UUID
  is generated. The ID is echoed back in the `X-Request-ID` response header.
- The ID is stored in an `AsyncLocalStorage` context, so any log emitted while
  handling the request automatically includes `requestId` — no manual plumbing.
- Background work is correlated by **job / email / outbox identifiers**, not by
  the HTTP request ID. HTTP request IDs do **not** propagate into BullMQ jobs;
  each log carries the relevant `jobId`, `emailId`, `queue`, `outboxEventId`
  instead.

### HTTP logging

- Morgan logs `method`, sanitized `path`, `status` and `response-time`.
- **Query strings are stripped** from the path; headers, cookies and bodies are
  never logged.
- Requests that end in an error or client disconnect are logged (Morgan uses
  `on-finished`, which fires on `finish` and `close`).
- Health checks are skipped by default to avoid noise. Configure the excluded
  paths with `LOG_HTTP_IGNORE_PATHS` (comma-separated; a trailing `*` matches a
  prefix, e.g. `/health,/internal/*`).

### Fields that are logged

- Lifecycle/context: `service`, `env`, `timestamp`, `level`, `message`,
  `requestId`, `port`, `signal`.
- HTTP: `method`, `path` (no query), `status`, `response-time`.
- Email/queue: `queue`, `jobId`, `emailId`, `senderId`, `batchId`,
  `providerMessageId`, `durationMs`, `attemptsMade`, `maxAttempts`, `retryable`,
  `previewUrl` (non-production only).
- Outbox: `outboxEventId`, `eventType`, `aggregateId`, `examined`, `published`,
  `delayMs`.
- Errors: `name`, `message`, `code`, `stack` (server-side only).

### Sensitive data that is deliberately excluded

Never logged: full email bodies/subjects, recipient addresses, `DATABASE_URL` /
`REDIS_URL`, SMTP credentials, passwords, API keys, access tokens, raw
`Authorization` headers, cookies, query-string values, and request bodies.
Errors are passed through `serializeError()` (message/stack/code only), so
arbitrary error properties are not dumped. Ethereal preview URLs are only logged
outside production, or when `LOG_EMAIL_PREVIEW_URLS=true`.

### Inspecting logs locally

```bash
# HTTP access logs (one line per request)
pnpm run dev            # then: curl http://localhost:3000/health
                        # (health checks are skipped by default; try /api/batches)

# Worker, Redis and email logs
pnpm run worker         # emits Redis connect/ready/reconnecting, job start/sent/failed

# Narrow to a level or grep for a correlation ID
LOG_LEVEL=http pnpm run dev
pnpm run worker 2>&1 | Select-String "emailId"
```

### Response for fatal failures

`installProcessErrorHandlers()` (called by the HTTP server and worker entry
points) logs `uncaughtException` / `unhandledRejection` with a full stack and
then **exits with a non-zero code** — the process never continues silently after
a fatal failure. Importing the logger from a script does not install these
handlers.

> Note: the development seed/test scripts (`src/scripts/test-feed.ts`,
> `src/db_test.ts`, `src/utils/test/redis-test.ts`) also log through Winston, so
> their output now carries a timestamp/level prefix (or JSON in production).

## Rate limiting

Outbound sends are gated per **sender** and per **tenant (user)** by a single
atomic Redis Lua script in `src/utils/rate-limiter.ts` (`reserveSendCapacity`).
The worker calls it immediately before claiming an email, so a job that is over
quota is *delayed* rather than sent or failed.

### What it enforces

| Check | Scope | Source |
| --- | --- | --- |
| Sender hourly quota | One sender | `senders.hourlyLimit` |
| Tenant hourly quota | One user (all their senders) | `users.tenantHourlyLimit` (default `100`) |
| Minimum send spacing | One sender | `SENDER_MIN_INTERVAL_MS` |

The window is a **sliding 60 minutes** (overridable via `windowMs`). Every check
uses **Redis server time**, never the worker clock, so multiple workers agree.

### Behaviour

- A reservation is recorded in a per-sender and a per-tenant sorted set
  (member = `emailId`, score = reservation time).
- Reservations are **idempotent by `emailId`**: re-processing the same job never
  consumes capacity twice.
- On a breach the job is moved to the delayed set until capacity frees up
  (`job.moveToDelayed` + `DelayedError`) and **nothing is consumed**. `retryAt`
  is the largest of the violated deadlines.
- Once a reservation is taken (sending is about to begin) it is **not released**
  — even if SMTP returns an ambiguous error — it simply ages out of the window.
  This stops a flapping SMTP endpoint from exceeding the quota.
- Keys are hash-tagged by user id (`rl:{u:<userId>}:…`) so the tenant set is
  shared across all of a user's senders while every key the script touches stays
  in one Redis Cluster slot.
- Key TTLs are `window + minInterval + 60s`.
- A sender with no configured sender (API-created batches have no sender id)
  still has its **tenant** quota enforced.
- If a sender has a Slack webhook (`senders.slackWebhookUrl`), a rate-limit block
  posts a throttled alert (at most one per sender per 5 minutes).

### Inspecting the keys

```bash
pnpm run worker     # emits "Email send rate-limited; delaying job" with reason/delayMs

# e.g. redis-cli
# ZRANGE rl:{u:1}:sender:<senderId>:res 0 -1 WITHSCORES
# ZCARD  rl:{u:1}:tenant:res
```

Reasons reported: `sender-hourly`, `tenant-hourly`, `sender-spacing`.

## REST API

Every route is mounted under `/api`. Routes live in `src/routes/`, handlers in
`src/controllers/`, business logic in `src/services/`, and each request is
validated with **zod** (`src/validators/`) by `src/middleware/validate.ts`
before a handler runs — invalid input never reaches a service or the database.

### Authentication (integration point)

**Authentication is not implemented yet.** `src/middleware/auth.ts` exposes a
single `requireAuth` middleware that:

1. trusts `req.auth` when a real auth layer has already populated it (Google
   OAuth, session or JWT — whichever gets wired in), otherwise
2. falls back to a fixed **development identity** from `AUTH_DEV_USER_ID`
   (ignored whenever `NODE_ENV=production`), otherwise
3. rejects the request with `401 UNAUTHENTICATED`.

The API **never** derives the current user from a request body, an arbitrary
header, or a query parameter. To embed a real provider, run it before
`requireAuth` and assign `req.auth = { userId }` (typed in
`src/types/express.d.ts`).

> Until a real provider is wired in, **do not expose this API publicly.** With
> `AUTH_DEV_USER_ID` unset — and always in production — every `/api` route
> returns 401.

### Error envelope

Every error — validation, auth, not found, conflict, or an unexpected 500 — uses
the same body:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid",
    "details": [
      { "path": "body.recipients[0].email", "message": "Must be a valid email address" }
    ],
    "requestId": "8f0c1a2b-…"
  }
}
```

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid body, query, params or malformed JSON |
| 401 | `UNAUTHENTICATED` | No identity / auth not configured |
| 403 | `FORBIDDEN` | Authenticated but not allowed |
| 404 | `NOT_FOUND` | Resource is missing **or belongs to another user** |
| 409 | `CONFLICT` | State conflict (for example an inactive sender) |
| 500 | `INTERNAL_ERROR` | Unexpected failure (no stack or DB detail leaked) |

`requestId` matches the `X-Request-ID` response header. Errors are logged exactly
once at the boundary (`src/middleware/error-handler.ts`); stack traces and SQL
never reach the client. A resource owned by another user is always reported as
`404`, so batch/email existence is not leaked across accounts.

### Endpoints

#### `POST /api/batches`

Creates a batch, its individual emails, and one `email.schedule` **outbox** event
per email — all inside a single transaction. No BullMQ job is ever enqueued from
HTTP; the outbox dispatcher is the only publisher.

`{{name}}` and `{{email}}` in `subject`/`body` are rendered per recipient at
creation time. `scheduledAt` is `startAt + index × delayMs`.

```json
{
  "senderId": "3f1c…",
  "subject": "Hello {{name}}",
  "body": "Hi {{name}}, this is for {{email}}.",
  "startAt": "2026-10-20T10:00:00.000Z",
  "delayMs": 1000,
  "hourlyLimit": 100,
  "recipients": [
    "alice@example.com",
    { "email": "bob@example.com", "name": "Bob" }
  ],
  "idempotencyKey": "optional-key"
}
```

The idempotency key may be supplied as the `Idempotency-Key` header or the
`idempotencyKey` body field (header wins). When neither is present a UUID is
generated. Response `201`:

```json
{
  "message": "Email batch scheduled successfully",
  "batchId": "9b2e…",
  "recipientCount": 2,
  "schedulingSummary": {
    "idempotencyKey": "optional-key",
    "startAt": "2026-10-20T10:00:00.000Z",
    "delayMs": 1000,
    "hourlyLimit": 100,
    "firstScheduledAt": "2026-10-20T10:00:00.000Z",
    "lastScheduledAt": "2026-10-20T10:00:01.000Z",
    "outboxEventsCreated": 2
  }
}
```

Replaying the same idempotency key returns `200` with `"idempotentReplay": true`
and the original `batchId` — never a duplicate batch, email or outbox event.

#### `GET /api/batches`

Query: `page` (default 1), `limit` (default 20, max 100), `senderId`,
`createdFrom`, `createdTo`. Newest first.

```json
{
  "data": [
    {
      "id": "9b2e…",
      "senderId": "3f1c…",
      "subject": "Hello {{name}}",
      "startAt": "2026-10-20T10:00:00.000Z",
      "delayMs": 1000,
      "hourlyLimit": 100,
      "totalEmails": 2,
      "createdAt": "2026-10-17T16:00:00.000Z",
      "deliveryCounts": { "scheduled": 2, "sending": 0, "sent": 0, "failed": 0, "unknown": 0, "total": 2 }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

#### `GET /api/batches/:id`

Returns one batch with its public sender details and delivery counts:

```json
{
  "batch": {
    "id": "9b2e…",
    "subject": "Hello {{name}}",
    "deliveryCounts": { "scheduled": 2, "sending": 0, "sent": 0, "failed": 0, "unknown": 0, "total": 2 },
    "sender": { "id": "3f1c…", "fromName": "Team", "fromEmail": "team@example.com", "hourlyLimit": 500, "isActive": true }
  }
}
```

#### `POST /api/batches/:id/schedule`

Idempotently guarantees that every eligible email (`status = 'scheduled'`) has
exactly one live `email.schedule` outbox event, inserting only what is missing.
Safe to call repeatedly: it never duplicates events or queue jobs, and it repairs
a batch whose events were lost. A row lock serializes concurrent calls.

```json
{
  "message": "Batch is already scheduled",
  "batchId": "9b2e…",
  "totalEmails": 2,
  "eligible": 2,
  "alreadyScheduled": 2,
  "newlyScheduled": 0,
  "ineligible": 0
}
```

#### `GET /api/emails`

Query: `page`, `limit`, `batchId`, `senderId`, `status`
(`scheduled|sending|sent|failed|unknown`) and `recipient` (case-insensitive exact
match). The full message `body` is never returned.

#### `GET /api/emails/:id`

Returns one email including `providerMessageId` and a **sanitized** `lastError`
(truncated and with credential-looking text redacted). The `body` is not exposed.

#### `GET /api/dashboard/stats`

Aggregated from SQL for the authenticated user only (no rows loaded into memory):

```json
{
  "generatedAt": "2026-10-17T16:00:00.000Z",
  "totals": { "batches": 12, "emails": 340 },
  "byStatus": { "scheduled": 40, "sending": 1, "sent": 296, "failed": 2, "unknown": 1 },
  "sentLast24Hours": 88,
  "scheduled": 40,
  "failed": 2,
  "perSender": [
    { "senderId": "3f1c…", "fromEmail": "team@example.com", "fromName": "Team", "emails": 340, "sent": 296 }
  ],
  "source": "database"
}
```

### Examples

```bash
# Local development identity (never in production)
export AUTH_DEV_USER_ID=1
BASE=http://localhost:3000

# Create a batch (201); re-use the Idempotency-Key header to replay it (200).
curl -sS -X POST "$BASE/api/batches" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{
    "senderId": "PUT-A-SENDER-UUID",
    "subject": "Hello {{name}}",
    "body": "Hi {{name}}, this is for {{email}}.",
    "startAt": "2026-10-20T10:00:00.000Z",
    "delayMs": 1000,
    "hourlyLimit": 100,
    "recipients": [
      { "email": "alice@example.com", "name": "Alice" },
      { "email": "bob@example.com", "name": "Bob" }
    ]
  }'

# List batches, read one, re-arm it, list its emails, and read the dashboard.
curl -sS "$BASE/api/batches?page=1&limit=20"
curl -sS "$BASE/api/batches/PUT-A-BATCH-UUID"
curl -sS -X POST "$BASE/api/batches/PUT-A-BATCH-UUID/schedule"
curl -sS "$BASE/api/emails?batchId=PUT-A-BATCH-UUID&status=scheduled"
curl -sS "$BASE/api/emails/PUT-AN-EMAIL-UUID"
curl -sS "$BASE/api/dashboard/stats"
```

## Testing

```bash
pnpm test                  # every suite (unit, API, rate-limiter, worker)
pnpm run test:unit         # rate-limiter suites (real Redis + Lua limiter)
pnpm run test:integration  # worker suites (module-mocked mailer)
```

To run just the REST API and pure-unit suites:

```bash
node --import tsx --test tests/unit/*.test.ts tests/api/*.test.ts
```

- Tests use the built-in **`node:test`** runner with **`tsx`** (no Vitest/Jest).
  Suites share one Postgres database and one Redis database, so the full run is
  serialized with `--test-concurrency=1`.
- `tests/setup-env.ts` is imported first by every test file. It forces
  `NODE_ENV=test`, moves Redis to logical **DB 15**, points SMTP at a dead local
  endpoint, and clears `AUTH_DEV_USER_ID` so each test opts in to an identity.
- API tests start the real app on an ephemeral port (`createApp()` in
  `src/app.ts` is exported for this) and talk to the **real database**. Every
  fixture creates its own user/sender and deletes every row afterwards — shared
  tables are never truncated and the shared Redis is never flushed.
- The API tests never start the mailer or the worker, so **no real email is
  sent**: they assert the outbox rows the dispatcher would consume and that the
  API publishes no BullMQ job of its own (checked by email id). The worker
  suites do run the worker, with `tests/helpers/mock-mailer.ts` replacing the
  real mailer.
- `AUTH_DEV_USER_ID` is set per test fixture, so cross-user isolation (a second
  user must not see the first user's batches or emails) is asserted for real.

## Database migrations

Migrations are managed by Drizzle Kit (`pnpm run db:generate` /
`pnpm run db:migrate`). The REST API adds:

- **`0004_silent_young_avengers.sql`** — `ALTER TABLE "emails" ADD COLUMN
  "recipientName" varchar(255)` (nullable), used to render `{{name}}`,
  `{{email}}` per recipient.

Apply it with `pnpm run db:migrate` before starting the server.

