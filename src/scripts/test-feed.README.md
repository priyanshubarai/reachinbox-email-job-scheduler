# `test-feed` — ReachInbox test-data seeder

Deterministic, repeatable fixtures for the ReachInbox email-scheduler **development/test**
database. It exercises users, senders, batches, emails (every status), send attempts and
the transactional outbox.

- Script: `src/scripts/test-feed.ts`
- npm script: `npm run db:seed:test`
- Namespace: `reachinbox-test-v1` (all deterministic ids derive from it)
- Reserved domain: `reachinbox-test-v1.example.com` (never real addresses)

---

## 1. Safety model

The seeder **refuses to run** unless all gates pass (exit code `1`, nothing written):

| Variable | Required value |
| --- | --- |
| `SEED_TEST_DATA` | `true` |
| `ALLOW_NEON_TEST_SEED` | `true` |
| `NODE_ENV` | `development` or `test` |

Guarantees:

- **Insert-only.** It never truncates, drops or deletes rows.
- **No secret leakage.** `DATABASE_URL`, `REDIS_URL` and SMTP credentials are never printed.
- **Deterministic + conflict-safe.** Explicit deterministic UUIDs (v5-style, namespace
  `reachinbox-test-v1`) plus `ON CONFLICT DO NOTHING`. Re-running never duplicates rows,
  never rewrites delivery status, and never turns a `sent` email back into `scheduled`.
- **Single transaction.** All database writes run in one `db.transaction(...)`, so a
  failure rolls the whole seed back.
- **Plan validation.** A validator rejects contradictory fixtures (e.g. a `sent` email
  without `sentAt`, a batch whose `totalEmails` disagrees with its email count, an outbox
  event pointing at no email) before any write.

Set the gates in your shell (do **not** commit them):

```powershell
$env:SEED_TEST_DATA="true"
$env:ALLOW_NEON_TEST_SEED="true"
# NODE_ENV=development already comes from .env
```

---

## 2. Usage

```powershell
# What would be created (no writes, no Redis):
npm run db:seed:test -- --dry-run

# Database fixtures only (Mode A — Redis untouched, no email sent):
npm run db:seed:test

# Larger load-test batch:
npm run db:seed:test -- --count=500

# Mode B — ALSO publish selected still-scheduled emails to BullMQ:
#   (requires local Redis; does NOT start the worker)
npm run db:seed:test -- --enqueue

# Help:
npm run db:seed:test -- --help
```

Options: `--dry-run`, `--count=<n>` (1–1000, default 150), `--enqueue`, `--help`.

### Modes

- **Mode A (default).** Inserts database fixtures. Redis is never touched. No email is sent.
- **Mode B (`--enqueue`).** After committing, it pre-flights Redis with a short-lived probe.
  If Redis is reachable it publishes **only** emails that are still `scheduled` and belong
  to a safe batch (`batch-soon`, `batch-ratelimit`), using the real queue name
  (`email-sending`), job name (`send-email`), payload (`{ emailId }`) and a deterministic
  `jobId` (`email.id`). It re-checks `status = 'scheduled'` in the database immediately
  before publishing. Already-`sent`/`failed`/`unknown`/`sending` rows are never enqueued.
  If Redis is down, it warns and skips — the database seed still succeeds.
  **The worker is never started by this script.** Starting the worker will send real test
  email through Ethereal SMTP.

---

## 3. Fixture inventory

| Entity | Count | Coverage |
| --- | --- | --- |
| users | 2 | `user.one`, `user.two` (tenant isolation) |
| senders | 4 | normal (limit 50), low-quota (limit **2**), no-Slack (null webhook), tenant-2 (limit 10) |
| email_batches | 9 | future, starts-soon, 2 s interval, large (`--count`), completed, failed recipients, partially processed, rate-limit, tenant-2 |
| emails | 150 + 38 = **188** | `scheduled` 175, `sent` 7, `failed` 3, `sending` 1, `unknown` 2 |
| send_attempts | 16 | success, failed (2 attempts), ambiguous (`unknown`), in-flight (`sending`) |
| outbox_events | 179 | pending-ready, pending-future (`availableAt`), processed, failed attempt + error, references-already-sent, recoverable |

Email content covers repeated keywords `Demo`, `Invoice`, `Follow-up`, `Product`, distinct
subjects/bodies, multiple recipients per subject, past/now/near-future/past timestamps,
a duplicate-looking pair with distinct idempotency keys, rows for both tenants, and a
150-row batch for pagination.

Every batch's `totalEmails` equals its real email count. `sent` rows always carry
`sentAt` + `providerMessageId`; `failed`/`unknown` always carry `lastError`.

---

## 4. How to exercise things with these fixtures

- **Restart recovery / idempotency:** the `sending` row and the `pending-sent` outbox event
  model interrupted work. Restart the worker and confirm it does not double-send
  (`jobId = email.id`) and reconciles the outbox row pointing at a `sent` email by marking
  it `processed` instead of sending.
- **Hourly limits:** `batch-ratelimit` has 6 emails at an identical instant for
  `sender-low-quota` (limit 2). See the limitation below — the counter is not seeded.
- **Retries:** `failed-*` emails have two `send_attempts`; `outbox-special-retry` has
  `attempts = 2` and a `lastError` with a deferred `availableAt`.
- **Search / dashboard:** query `scheduled` and `sent`/`failed` tabs, and full-text search
  (Postgres `ILIKE`) over the seeded subjects.
- **Tenant isolation:** filter by `userId`: `user.one` owns everything except
  `batch-tenant-2` and `sender-tenant-2`.

Example verification queries:

```sql
select status, count(*) from emails group by status;                 -- scheduled/sent/failed/sending/unknown
select status, count(*) from outbox_events group by status;          -- pending / processed
select count(*) from emails where scheduled_at > now();              -- upcoming
select count(*) from emails where last_error is not null;            -- failures / ambiguous
```

---

## 5. Schema additions (applied via migration `0002`)

Added to support sender/quota fixtures (additive only — no existing column changed):

- **`senders`** — `userId` FK, `fromName`, `fromEmail`, `hourlyLimit`, `isActive`,
  `slackWebhookUrl` (NULL = not connected; no fake tokens are stored), `slackConnectedAt`.
  Unique `(userId, fromEmail)`.
- **`send_attempts`** — `emailId` FK, `attemptNumber`, `status`, `providerMessageId`,
  `error`, `attemptedAt`. Unique `(emailId, attemptNumber)`.
- **`email_batches.senderId`**, **`emails.senderId`** — nullable FKs to `senders`.

Applied with `npm run db:migrate` (`drizzle-kit migrate`).

---

## 6. Known limitations & smallest recommended follow-ups

These scenarios **cannot** be represented by the current implementation and are **not**
faked by the seeder:

1. **Hourly rate limiting is not enforced and no counters exist.** `hourlyLimit` is stored
   on the batch but no code or Redis key consumes it, so inserting historical emails does
   **not** consume any quota. Recommended: a Redis counter keyed by
   `rl:sender:{senderId}:{hourWindow}` incremented in the worker (or a BullMQ limiter),
   delaying overflow into the next window. Then use `batch-ratelimit` to observe it. Do
   **not** hand-write quota counters into Redis.
2. **No Elasticsearch.** Search is Postgres only; there is no indexer to run, so no
   reindex step exists. Recommended: an indexer module + a `--reindex` step that reads
   `emails` and writes documents keyed by tenant + email id.
3. **The worker never writes `status = 'failed'`.** On SMTP error it writes `unknown`.
   The seeded `failed` rows are supported by the column (varchar, no CHECK) and expected
   by the Sent-Emails UI, but the worker must be updated to map permanent failures to
   `failed` to keep parity.
4. **`send_attempts` is not written by the worker yet** — only the seeder populates it.
5. **No batch status column.** Batch progress is inferred from its emails.
6. **No inter-send delay enforcement.** `delayMs` is stored but the worker does not
   throttle between sends (only BullMQ retry/backoff). Recommended: a limiter or a small
   delay in the worker.

---

## 7. Idempotency notes

Deterministic ids come from `sha1("reachinbox-test-v1:<kind>:<key>")` formatted as a v5
UUID, so the same fixtures always produce the same primary keys. Users use an identity PK
and are matched by their reserved-domain unique email. Running the seeder twice yields
`inserted=0, skipped=<all>` and leaves statuses untouched.
