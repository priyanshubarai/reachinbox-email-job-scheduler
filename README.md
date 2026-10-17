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
| `LOG_LEVEL` | Minimum log level (see below) |

## Scripts

```bash
pnpm run dev        # start the HTTP server with hot reload (tsx watch)
pnpm run worker     # start the worker + outbox dispatcher
pnpm run build      # compile TypeScript to dist/
pnpm start          # run the compiled server (node dist/app.js)
pnpm run lint       # ESLint
pnpm run db:push    # push the Drizzle schema
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
