import "dotenv/config";
import { createHash } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { inArray } from "drizzle-orm";
import db from "../db/index.js";
import logger, { serializeError } from "../lib/logger.js";
import {
  emailBatchesTable,
  emailsTable,
  outboxEventsTable,
  sendAttemptsTable,
  sendersTable,
  usersTable,
} from "../db/schema.js";


const SEED_NAMESPACE = "reachinbox-test-v1";
const TEST_DOMAIN = "reachinbox-test-v1.example.com";

const DEFAULT_LARGE_BATCH_COUNT = 150;
const MIN_LARGE_BATCH_COUNT = 1;
const MAX_LARGE_BATCH_COUNT = 1000;

/** Batches whose still-scheduled emails are safe to enqueue in Mode B. */
const ENQUEUE_SAFE_BATCH_KEYS = new Set(["batch-soon", "batch-ratelimit"]);

type EmailStatus = "scheduled" | "sent" | "failed" | "sending" | "unknown";

interface PlannedUser {
  key: string;
  email: string;
  name: string;
  age: number;
}

interface PlannedSender {
  key: string;
  id: string;
  userKey: string;
  fromName: string;
  fromEmail: string;
  hourlyLimit: number;
  isActive: boolean;
  slackWebhookUrl: string | null;
  slackConnectedAt: Date | null;
  createdAt: Date;
}

interface PlannedBatch {
  key: string;
  id: string;
  userKey: string;
  senderId: string | null;
  subject: string;
  body: string;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  totalEmails: number;
  createdAt: Date;
}

interface PlannedEmail {
  key: string;
  id: string;
  batchKey: string;
  batchId: string;
  senderId: string | null;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: Date;
  status: EmailStatus;
  sentAt: Date | null;
  providerMessageId: string | null;
  lastError: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

interface PlannedAttempt {
  key: string;
  id: string;
  emailId: string;
  attemptNumber: number;
  status: string;
  providerMessageId: string | null;
  error: string | null;
  attemptedAt: Date;
}

interface PlannedOutbox {
  key: string;
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: "pending" | "processed";
  attempts: number;
  availableAt: Date;
  processedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

interface Plan {
  users: PlannedUser[];
  senders: PlannedSender[];
  batches: PlannedBatch[];
  emails: PlannedEmail[];
  attempts: PlannedAttempt[];
  outbox: PlannedOutbox[];
}

interface ExistingState {
  userIdByEmail: Map<string, number>;
  senderIds: Set<string>;
  batchIds: Set<string>;
  emailStatusById: Map<string, string>;
  attemptIds: Set<string>;
  outboxIds: Set<string>;
}

interface EntityCounts {
  planned: number;
  inserted: number;
  skipped: number;
}

interface SeedSummary {
  users: EntityCounts;
  senders: EntityCounts;
  batches: EntityCounts;
  emails: EntityCounts;
  attempts: EntityCounts;
  outbox: EntityCounts;
  emailsByStatus: Map<string, EntityCounts>;
}

interface CliArgs {
  help: boolean;
  dryRun: boolean;
  enqueue: boolean;
  count: number;
}

// ---------------------------------------------------------------------------
// Deterministic identifiers
// ---------------------------------------------------------------------------

/** RFC-4122 v5-style UUID derived from the seed namespace (no dependency). */
function seedUuid(kind: string, key: string): string {
  const hex = createHash("sha1")
    .update(`${SEED_NAMESPACE}:${kind}:${key}`)
    .digest("hex")
    .slice(0, 32);

  const timeLow = hex.slice(0, 8);
  const timeMid = hex.slice(8, 12);
  const timeHigh = `5${hex.slice(13, 16)}`;
  const variantNibble = (
    (Number.parseInt(hex.charAt(16), 16) & 0x3) |
    0x8
  ).toString(16);
  const clockSeq = `${variantNibble}${hex.slice(17, 20)}`;
  const node = hex.slice(20, 32);

  return `${timeLow}-${timeMid}-${timeHigh}-${clockSeq}-${node}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  logger.info(
    [
      "",
      `${SEED_NAMESPACE} — ReachInbox development/test fixture seeder`,
      "",
      "Usage:",
      "  npm run db:seed:test -- [options]",
      "",
      "Options:",
      "  --dry-run        Report what would be created. Writes nothing.",
      `  --count=<n>      Emails in the large load-test batch (default ${DEFAULT_LARGE_BATCH_COUNT}, ${MIN_LARGE_BATCH_COUNT}-${MAX_LARGE_BATCH_COUNT}).`,
      "  --enqueue        After seeding, publish selected still-scheduled test",
      "                   emails to the existing BullMQ queue (Mode B).",
      "                   Does NOT start the worker. Requires local Redis.",
      "  --help           Show this help.",
      "",
      "Required safety gates (environment variables):",
      "  SEED_TEST_DATA=true",
      "  NODE_ENV=development   (or: test)",
      "  ALLOW_NEON_TEST_SEED=true",
      "",
      "Example (PowerShell):",
      '  $env:SEED_TEST_DATA="true"; $env:ALLOW_NEON_TEST_SEED="true"; npm run db:seed:test -- --dry-run',
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    dryRun: false,
    enqueue: false,
    count: DEFAULT_LARGE_BATCH_COUNT,
  };

  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") {
      args.help = true;
    } else if (raw === "--dry-run") {
      args.dryRun = true;
    } else if (raw === "--enqueue") {
      args.enqueue = true;
    } else if (raw.startsWith("--count=")) {
      const value = raw.slice("--count=".length);
      const parsed = Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < MIN_LARGE_BATCH_COUNT ||
        parsed > MAX_LARGE_BATCH_COUNT
      ) {
        throw new Error(
          `--count must be an integer between ${MIN_LARGE_BATCH_COUNT} and ${MAX_LARGE_BATCH_COUNT}`,
        );
      }
      args.count = parsed;
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }
  }

  return args;
}

function assertSafetyGates(): void {
  const problems: string[] = [];

  if (process.env.SEED_TEST_DATA !== "true") {
    problems.push("SEED_TEST_DATA must be exactly \"true\"");
  }

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    problems.push("NODE_ENV must be \"development\" or \"test\"");
  }

  if (process.env.ALLOW_NEON_TEST_SEED !== "true") {
    problems.push("ALLOW_NEON_TEST_SEED must be exactly \"true\"");
  }

  if (!process.env.DATABASE_URL) {
    problems.push("DATABASE_URL must be configured");
  }

  if (problems.length > 0) {
    logger.error(
      "\nRefusing to run — safety gates are not satisfied:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nSee `npm run db:seed:test -- --help`.\n",
    );
    process.exit(1);
  }

  logger.info("Safety gates: passed (values intentionally not printed).");
}

// ---------------------------------------------------------------------------
// Fixture plan
// ---------------------------------------------------------------------------

function buildPlan(count: number): Plan {
  const now = Date.now();
  const at = (ms: number): Date => new Date(now + ms);

  const users: PlannedUser[] = [
    {
      key: "user-1",
      email: `user.one@${TEST_DOMAIN}`,
      name: "Seed User One",
      age: 30,
    },
    {
      key: "user-2",
      email: `user.two@${TEST_DOMAIN}`,
      name: "Seed User Two",
      age: 28,
    },
  ];

  const senders: PlannedSender[] = [
    {
      key: "sender-normal",
      id: seedUuid("sender", "sender-normal"),
      userKey: "user-1",
      fromName: "Normal Sender",
      fromEmail: `normal@${TEST_DOMAIN}`,
      hourlyLimit: 50,
      isActive: true,
      slackWebhookUrl: null,
      slackConnectedAt: null,
      createdAt: at(-6 * 60 * 60 * 1000),
    },
    {
      key: "sender-low-quota",
      id: seedUuid("sender", "sender-low-quota"),
      userKey: "user-1",
      fromName: "Low Quota Sender",
      fromEmail: `low.quota@${TEST_DOMAIN}`,
      hourlyLimit: 2,
      isActive: true,
      slackWebhookUrl: null,
      slackConnectedAt: null,
      createdAt: at(-6 * 60 * 60 * 1000),
    },
    {
      key: "sender-no-slack",
      id: seedUuid("sender", "sender-no-slack"),
      userKey: "user-1",
      fromName: "No Slack Sender",
      fromEmail: `no.slack@${TEST_DOMAIN}`,
      hourlyLimit: 20,
      isActive: true,
      slackWebhookUrl: null,
      slackConnectedAt: null,
      createdAt: at(-5 * 60 * 60 * 1000),
    },
    {
      key: "sender-tenant-2",
      id: seedUuid("sender", "sender-tenant-2"),
      userKey: "user-2",
      fromName: "Tenant Two Sender",
      fromEmail: `tenant.two@${TEST_DOMAIN}`,
      hourlyLimit: 10,
      isActive: true,
      slackWebhookUrl: null,
      slackConnectedAt: null,
      createdAt: at(-4 * 60 * 60 * 1000),
    },
  ];

  const senderIdByKey = new Map(senders.map((s) => [s.key, s.id]));

  const batches: PlannedBatch[] = [];
  const emails: PlannedEmail[] = [];
  const attempts: PlannedAttempt[] = [];
  const outbox: PlannedOutbox[] = [];

  const rcpt = (batchKey: string, i: number): string =>
    `lead.${batchKey}.${i}@${TEST_DOMAIN}`;

  const addBatch = (
    batch: Omit<PlannedBatch, "id" | "totalEmails" | "createdAt"> & {
      createdAt?: Date;
    },
  ): PlannedBatch => {
    const stored: PlannedBatch = {
      ...batch,
      id: seedUuid("batch", batch.key),
      totalEmails: 0,
      createdAt: batch.createdAt ?? at(-60 * 60 * 1000),
    };
    batches.push(stored);
    return stored;
  };

  const addEmail = (
    input: Omit<PlannedEmail, "id" | "idempotencyKey" | "createdAt" | "updatedAt">,
  ): PlannedEmail => {
    const stored: PlannedEmail = {
      ...input,
      id: seedUuid("email", input.key),
      idempotencyKey: `${SEED_NAMESPACE}:${input.key}`,
      createdAt: input.scheduledAt,
      updatedAt: input.scheduledAt,
    };
    emails.push(stored);
    return stored;
  };

  const addOutbox = (
    input: Omit<PlannedOutbox, "id" | "createdAt"> & { createdAt?: Date },
  ): PlannedOutbox => {
    const stored: PlannedOutbox = {
      ...input,
      id: seedUuid("outbox", input.key),
      createdAt: input.createdAt ?? at(-30 * 60 * 1000),
    };
    outbox.push(stored);
    return stored;
  };

  // --- Batch 1: future ---
  const bFuture = addBatch({
    key: "batch-future",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Product Update: Future Rollout",
    body: "This Product update is scheduled for the future window.",
    startAt: at(2 * 60 * 60 * 1000),
    delayMs: 60_000,
    hourlyLimit: 50,
  });
  for (let i = 0; i < 3; i += 1) {
    addEmail({
      key: `future-${i}`,
      batchKey: bFuture.key,
      batchId: bFuture.id,
      senderId: bFuture.senderId,
      recipient: rcpt(bFuture.key, i),
      subject: bFuture.subject,
      body: bFuture.body,
      scheduledAt: at(2 * 60 * 60 * 1000 + i * 60_000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }
  // Duplicate-looking pair across batches: identical content/recipient,
  // distinct idempotency keys (legitimate in the real system).
  const dupRecipient = `lead.duplicate.check@${TEST_DOMAIN}`;
  addEmail({
    key: "future-dup-a",
    batchKey: bFuture.key,
    batchId: bFuture.id,
    senderId: bFuture.senderId,
    recipient: dupRecipient,
    subject: "Follow-up: Duplicate Check",
    body: "Same content, distinct idempotency keys.",
    scheduledAt: at(2 * 60 * 60 * 1000 + 5 * 60_000),
    status: "scheduled",
    sentAt: null,
    providerMessageId: null,
    lastError: null,
  });

  // --- Batch 2: starts soon ---
  const bSoon = addBatch({
    key: "batch-soon",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Follow-up: Starts Soon",
    body: "This Follow-up batch starts in about thirty seconds.",
    startAt: at(30_000),
    delayMs: 5_000,
    hourlyLimit: 50,
  });
  for (let i = 0; i < 3; i += 1) {
    addEmail({
      key: `soon-${i}`,
      batchKey: bSoon.key,
      batchId: bSoon.id,
      senderId: bSoon.senderId,
      recipient: rcpt(bSoon.key, i),
      subject: bSoon.subject,
      body: bSoon.body,
      scheduledAt: at(30_000 + i * 5_000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }
  // Second half of the duplicate-looking pair (same recipient/content, new key).
  addEmail({
    key: "soon-dup-b",
    batchKey: bSoon.key,
    batchId: bSoon.id,
    senderId: bSoon.senderId,
    recipient: dupRecipient,
    subject: "Follow-up: Duplicate Check",
    body: "Same content, distinct idempotency keys.",
    scheduledAt: at(2 * 60 * 60 * 1000 + 5 * 60_000 + 1000),
    status: "scheduled",
    sentAt: null,
    providerMessageId: null,
    lastError: null,
  });

  // --- Batch 3: 2-second interval ---
  const bInterval = addBatch({
    key: "batch-interval-2s",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Demo Invite: Two Second Interval",
    body: "Demo invites spaced two seconds apart to exercise throttling.",
    startAt: at(5 * 60 * 1000),
    delayMs: 2000,
    hourlyLimit: 50,
  });
  for (let i = 0; i < 5; i += 1) {
    addEmail({
      key: `interval-${i}`,
      batchKey: bInterval.key,
      batchId: bInterval.id,
      senderId: bInterval.senderId,
      recipient: rcpt(bInterval.key, i),
      subject: bInterval.subject,
      body: bInterval.body,
      scheduledAt: at(5 * 60 * 1000 + i * 2000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }

  // --- Batch 4: large load-test batch ---
  const bLarge = addBatch({
    key: "batch-large",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Invoice Batch: Large Volume",
    body: "A large Invoice batch used for pagination and throughput testing.",
    startAt: at(10 * 60 * 1000),
    delayMs: 1000,
    hourlyLimit: 200,
  });
  for (let i = 0; i < count; i += 1) {
    addEmail({
      key: `large-${i}`,
      batchKey: bLarge.key,
      batchId: bLarge.id,
      senderId: bLarge.senderId,
      recipient: rcpt(bLarge.key, i),
      subject: bLarge.subject,
      body: bLarge.body,
      scheduledAt: at(10 * 60 * 1000 + i * 1000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }

  // --- Batch 5: completed (all sent) ---
  const bCompleted = addBatch({
    key: "batch-completed",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Demo Recap: Completed Batch",
    body: "Every email in this Demo recap was delivered.",
    startAt: at(-3 * 60 * 60 * 1000),
    delayMs: 60_000,
    hourlyLimit: 50,
    createdAt: at(-4 * 60 * 60 * 1000),
  });
  for (let i = 0; i < 4; i += 1) {
    const scheduledAt = at(-3 * 60 * 60 * 1000 + i * 60_000);
    const sentAt = new Date(scheduledAt.getTime() + 2000);
    const email = addEmail({
      key: `completed-${i}`,
      batchKey: bCompleted.key,
      batchId: bCompleted.id,
      senderId: bCompleted.senderId,
      recipient: rcpt(bCompleted.key, i),
      subject: bCompleted.subject,
      body: bCompleted.body,
      scheduledAt,
      status: "sent",
      sentAt,
      providerMessageId: `seed-msg-completed-${i}`,
      lastError: null,
    });
    attempts.push({
      key: `attempt-${email.key}-1`,
      id: seedUuid("attempt", `${email.key}-1`),
      emailId: email.id,
      attemptNumber: 1,
      status: "sent",
      providerMessageId: email.providerMessageId,
      error: null,
      attemptedAt: sentAt,
    });
  }

  // --- Batch 6: failures + ambiguous SMTP outcomes ---
  const bFailed = addBatch({
    key: "batch-failed",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Invoice Reminder: Delivery Failures",
    body: "Invoice reminders that failed or returned an ambiguous SMTP result.",
    startAt: at(-2 * 60 * 60 * 1000),
    delayMs: 60_000,
    hourlyLimit: 50,
    createdAt: at(-3 * 60 * 60 * 1000),
  });
  for (let i = 0; i < 3; i += 1) {
    const scheduledAt = at(-2 * 60 * 60 * 1000 + i * 60_000);
    const email = addEmail({
      key: `failed-${i}`,
      batchKey: bFailed.key,
      batchId: bFailed.id,
      senderId: bFailed.senderId,
      recipient: rcpt(bFailed.key, i),
      subject: bFailed.subject,
      body: bFailed.body,
      scheduledAt,
      status: "failed",
      sentAt: null,
      providerMessageId: null,
      lastError: "SMTP 550 mailbox unavailable (seed)",
    });
    attempts.push({
      key: `attempt-${email.key}-1`,
      id: seedUuid("attempt", `${email.key}-1`),
      emailId: email.id,
      attemptNumber: 1,
      status: "failed",
      providerMessageId: null,
      error: email.lastError,
      attemptedAt: new Date(scheduledAt.getTime() + 1000),
    });
    attempts.push({
      key: `attempt-${email.key}-2`,
      id: seedUuid("attempt", `${email.key}-2`),
      emailId: email.id,
      attemptNumber: 2,
      status: "failed",
      providerMessageId: null,
      error: email.lastError,
      attemptedAt: new Date(scheduledAt.getTime() + 6000),
    });
  }
  for (let i = 0; i < 2; i += 1) {
    const scheduledAt = at(-90 * 60 * 1000 + i * 60_000);
    const email = addEmail({
      key: `unknown-${i}`,
      batchKey: bFailed.key,
      batchId: bFailed.id,
      senderId: bFailed.senderId,
      recipient: rcpt(bFailed.key, 10 + i),
      subject: bFailed.subject,
      body: bFailed.body,
      scheduledAt,
      status: "unknown",
      sentAt: null,
      providerMessageId: null,
      lastError: "SMTP connection reset after DATA (seed)",
    });
    attempts.push({
      key: `attempt-${email.key}-1`,
      id: seedUuid("attempt", `${email.key}-1`),
      emailId: email.id,
      attemptNumber: 1,
      status: "unknown",
      providerMessageId: null,
      error: email.lastError,
      attemptedAt: new Date(scheduledAt.getTime() + 1000),
    });
  }

  // --- Batch 7: partially processed ---
  const bPartial = addBatch({
    key: "batch-partial",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-normal") ?? null,
    subject: "Product Follow-up: Partial Batch",
    body: "Partially processed Product follow-up: some sent, some still scheduled.",
    startAt: at(-1 * 60 * 60 * 1000),
    delayMs: 60_000,
    hourlyLimit: 50,
    createdAt: at(-2 * 60 * 60 * 1000),
  });
  for (let i = 0; i < 3; i += 1) {
    const scheduledAt = at(-1 * 60 * 60 * 1000 + i * 60_000);
    const sentAt = new Date(scheduledAt.getTime() + 2000);
    const email = addEmail({
      key: `partial-sent-${i}`,
      batchKey: bPartial.key,
      batchId: bPartial.id,
      senderId: bPartial.senderId,
      recipient: rcpt(bPartial.key, i),
      subject: bPartial.subject,
      body: bPartial.body,
      scheduledAt,
      status: "sent",
      sentAt,
      providerMessageId: `seed-msg-partial-${i}`,
      lastError: null,
    });
    attempts.push({
      key: `attempt-${email.key}-1`,
      id: seedUuid("attempt", `${email.key}-1`),
      emailId: email.id,
      attemptNumber: 1,
      status: "sent",
      providerMessageId: email.providerMessageId,
      error: null,
      attemptedAt: sentAt,
    });
  }
  for (let i = 0; i < 2; i += 1) {
    addEmail({
      key: `partial-scheduled-${i}`,
      batchKey: bPartial.key,
      batchId: bPartial.id,
      senderId: bPartial.senderId,
      recipient: rcpt(bPartial.key, 10 + i),
      subject: bPartial.subject,
      body: bPartial.body,
      scheduledAt: at(45 * 60 * 1000 + i * 60_000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }
  {
    const email = addEmail({
      key: "partial-sending-0",
      batchKey: bPartial.key,
      batchId: bPartial.id,
      senderId: bPartial.senderId,
      recipient: rcpt(bPartial.key, 20),
      subject: bPartial.subject,
      body: bPartial.body,
      scheduledAt: at(-30_000),
      status: "sending",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
    attempts.push({
      key: `attempt-${email.key}-1`,
      id: seedUuid("attempt", `${email.key}-1`),
      emailId: email.id,
      attemptNumber: 1,
      status: "sending",
      providerMessageId: null,
      error: null,
      attemptedAt: at(-30_000),
    });
  }

  // --- Batch 8: hourly rate-limit fixture (low quota sender) ---
  const bRate = addBatch({
    key: "batch-ratelimit",
    userKey: "user-1",
    senderId: senderIdByKey.get("sender-low-quota") ?? null,
    subject: "Rate Limit Test: Low Quota Sender",
    body: "Six emails at the same instant for a sender whose hourly limit is two.",
    startAt: at(20_000),
    delayMs: 0,
    hourlyLimit: 2,
  });
  for (let i = 0; i < 6; i += 1) {
    // Identical scheduled times on purpose: exercises ordering/concurrency.
    addEmail({
      key: `ratelimit-${i}`,
      batchKey: bRate.key,
      batchId: bRate.id,
      senderId: bRate.senderId,
      recipient: rcpt(bRate.key, i),
      subject: bRate.subject,
      body: bRate.body,
      scheduledAt: at(20_000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }

  // --- Batch 9: tenant two ---
  const bTenant2 = addBatch({
    key: "batch-tenant-2",
    userKey: "user-2",
    senderId: senderIdByKey.get("sender-tenant-2") ?? null,
    subject: "Invoice: Tenant Two Isolation",
    body: "Tenant two Invoice data used to verify tenant isolation.",
    startAt: at(15 * 60 * 1000),
    delayMs: 5000,
    hourlyLimit: 10,
  });
  for (let i = 0; i < 4; i += 1) {
    addEmail({
      key: `tenant2-${i}`,
      batchKey: bTenant2.key,
      batchId: bTenant2.id,
      senderId: bTenant2.senderId,
      recipient: rcpt(bTenant2.key, i),
      subject: bTenant2.subject,
      body: bTenant2.body,
      scheduledAt: at(15 * 60 * 1000 + i * 5000),
      status: "scheduled",
      sentAt: null,
      providerMessageId: null,
      lastError: null,
    });
  }

  // --- Outbox: one pending "email.schedule" event per still-scheduled email ---
  const batchStartByKey = new Map(batches.map((b) => [b.key, b.startAt]));
  for (const email of emails) {
    if (email.status !== "scheduled") continue;

    // Batches that start now are "ready"; later batches use availableAt to defer.
    const ready =
      email.batchKey === "batch-soon" || email.batchKey === "batch-ratelimit";
    const availableAt = ready
      ? new Date(now)
      : (batchStartByKey.get(email.batchKey) ?? email.scheduledAt);

    addOutbox({
      key: `outbox-${email.key}`,
      eventType: "email.schedule",
      aggregateType: "email",
      aggregateId: email.id,
      payload: { emailId: email.id, batchId: email.batchId },
      status: "pending",
      attempts: 0,
      availableAt,
      processedAt: null,
      lastError: null,
      createdAt: email.scheduledAt,
    });
  }

  // --- Outbox: special cases ---
  const completedEmail = emails.find((e) => e.key === "completed-0");
  const completedEmail2 = emails.find((e) => e.key === "completed-1");
  const rateEmail = emails.find((e) => e.key === "ratelimit-0");
  const soonEmail = emails.find((e) => e.key === "soon-0");

  if (completedEmail) {
    addOutbox({
      key: "outbox-special-processed-sent",
      eventType: "email.schedule",
      aggregateType: "email",
      aggregateId: completedEmail.id,
      payload: { emailId: completedEmail.id, batchId: completedEmail.batchId },
      status: "processed",
      attempts: 1,
      availableAt: completedEmail.sentAt ?? completedEmail.scheduledAt,
      processedAt: completedEmail.sentAt ?? completedEmail.scheduledAt,
      lastError: null,
      createdAt: completedEmail.scheduledAt,
    });
  }

  if (completedEmail2) {
    // Pending event whose email was already sent: dispatcher must skip safely.
    addOutbox({
      key: "outbox-special-pending-sent",
      eventType: "email.schedule",
      aggregateType: "email",
      aggregateId: completedEmail2.id,
      payload: { emailId: completedEmail2.id, batchId: completedEmail2.batchId },
      status: "pending",
      attempts: 0,
      availableAt: new Date(now),
      processedAt: null,
      lastError: null,
      createdAt: completedEmail2.scheduledAt,
    });
  }

  if (rateEmail) {
    // A previously failed dispatch attempt, deferred into the future.
    addOutbox({
      key: "outbox-special-retry",
      eventType: "email.schedule",
      aggregateType: "email",
      aggregateId: rateEmail.id,
      payload: { emailId: rateEmail.id, batchId: rateEmail.batchId },
      status: "pending",
      attempts: 2,
      availableAt: new Date(now + 10 * 60 * 1000),
      processedAt: null,
      lastError: "BullMQ connection timeout (seed)",
      createdAt: new Date(now - 5 * 60 * 1000),
    });
  }

  if (soonEmail) {
    // A deliberately recoverable pending event for a scheduled email.
    addOutbox({
      key: "outbox-special-recoverable",
      eventType: "email.schedule",
      aggregateType: "email",
      aggregateId: soonEmail.id,
      payload: { emailId: soonEmail.id, batchId: soonEmail.batchId },
      status: "pending",
      attempts: 0,
      availableAt: new Date(now),
      processedAt: null,
      lastError: null,
      createdAt: soonEmail.scheduledAt,
    });
  }

  // --- Derive batch totals from their emails ---
  for (const batch of batches) {
    batch.totalEmails = emails.filter((e) => e.batchKey === batch.key).length;
  }

  // Deterministic ordering.
  emails.sort((a, b) => a.key.localeCompare(b.key));
  attempts.sort((a, b) => a.key.localeCompare(b.key));
  outbox.sort((a, b) => a.key.localeCompare(b.key));

  return { users, senders, batches, emails, attempts, outbox };
}

// ---------------------------------------------------------------------------
// Plan validation (fail fast on contradictory fixtures)
// ---------------------------------------------------------------------------

function validatePlan(plan: Plan): void {
  const errors: string[] = [];

  const userIds = new Set(plan.users.map((u) => u.key));
  const senderKeys = new Set(plan.senders.map((s) => s.key));
  const senderIds = new Set(plan.senders.map((s) => s.id));
  const batchKeys = new Set(plan.batches.map((b) => b.key));
  const emailIds = new Set(plan.emails.map((e) => e.id));
  const emailsByBatch = new Map<string, number>();
  const seenIdempotency = new Set<string>();
  const seenRecipientPerBatch = new Set<string>();

  for (const u of plan.users) {
    if (u.email.length > 255) errors.push(`user ${u.key}: email too long`);
  }

  for (const s of plan.senders) {
    if (!userIds.has(s.userKey)) {
      errors.push(`sender ${s.key}: unknown user ${s.userKey}`);
    }
    if (s.fromEmail.length > 320) {
      errors.push(`sender ${s.key}: fromEmail too long`);
    }
  }

  for (const b of plan.batches) {
    if (!userIds.has(b.userKey)) {
      errors.push(`batch ${b.key}: unknown user ${b.userKey}`);
    }
    if (b.senderId !== null && !senderIds.has(b.senderId)) {
      errors.push(`batch ${b.key}: unknown senderId`);
    }
    if (b.delayMs < 0) errors.push(`batch ${b.key}: negative delayMs`);
    if (b.hourlyLimit < 1) errors.push(`batch ${b.key}: hourlyLimit < 1`);
    if (b.subject.length > 998) errors.push(`batch ${b.key}: subject too long`);
  }

  for (const e of plan.emails) {
    if (!batchKeys.has(e.batchKey)) {
      errors.push(`email ${e.key}: unknown batch ${e.batchKey}`);
    }
    if (e.senderId !== null && !senderIds.has(e.senderId)) {
      errors.push(`email ${e.key}: unknown senderId`);
    }
    if (e.recipient.length > 320) {
      errors.push(`email ${e.key}: recipient too long`);
    }
    if (e.subject.length > 998) {
      errors.push(`email ${e.key}: subject too long`);
    }
    if (e.idempotencyKey.length > 255) {
      errors.push(`email ${e.key}: idempotencyKey too long`);
    }
    if (seenIdempotency.has(e.idempotencyKey)) {
      errors.push(`email ${e.key}: duplicate idempotencyKey`);
    }
    seenIdempotency.add(e.idempotencyKey);

    const recipientKey = `${e.batchKey}::${e.recipient}`;
    if (e.status === "scheduled") {
      if (seenRecipientPerBatch.has(recipientKey)) {
        errors.push(`email ${e.key}: duplicate recipient within batch`);
      }
      seenRecipientPerBatch.add(recipientKey);
    }

    // Non-contradictory status/timestamp invariants.
    if (e.status === "sent") {
      if (e.sentAt === null) errors.push(`email ${e.key}: sent without sentAt`);
      if (e.providerMessageId === null) {
        errors.push(`email ${e.key}: sent without providerMessageId`);
      }
    } else if (e.sentAt !== null) {
      errors.push(`email ${e.key}: ${e.status} must not have sentAt`);
    }

    if (e.status === "failed" || e.status === "unknown") {
      if (e.lastError === null) {
        errors.push(`email ${e.key}: ${e.status} without lastError`);
      }
    }

    if (e.status === "scheduled" || e.status === "sending") {
      if (e.lastError !== null) {
        errors.push(`email ${e.key}: ${e.status} must not have lastError`);
      }
    }

    emailsByBatch.set(e.batchKey, (emailsByBatch.get(e.batchKey) ?? 0) + 1);
  }

  for (const b of plan.batches) {
    const actual = emailsByBatch.get(b.key) ?? 0;
    if (b.totalEmails !== actual) {
      errors.push(
        `batch ${b.key}: totalEmails ${b.totalEmails} != email count ${actual}`,
      );
    }
  }

  for (const a of plan.attempts) {
    if (!emailIds.has(a.emailId)) {
      errors.push(`attempt ${a.key}: unknown emailId`);
    }
    if (a.attemptNumber < 1) {
      errors.push(`attempt ${a.key}: attemptNumber < 1`);
    }
  }

  for (const o of plan.outbox) {
    if (!emailIds.has(o.aggregateId)) {
      errors.push(`outbox ${o.key}: aggregateId does not reference a planned email`);
    }
    if (o.eventType !== "email.schedule") {
      errors.push(`outbox ${o.key}: unexpected eventType ${o.eventType}`);
    }
    if (o.aggregateType !== "email") {
      errors.push(`outbox ${o.key}: unexpected aggregateType ${o.aggregateType}`);
    }
    if (o.status === "processed" && o.processedAt === null) {
      errors.push(`outbox ${o.key}: processed without processedAt`);
    }
    if (o.status === "pending" && o.processedAt !== null) {
      errors.push(`outbox ${o.key}: pending with processedAt`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Fixture plan is inconsistent (${errors.length} problem(s)):\n` +
        errors.map((e) => `  - ${e}`).join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Existing-state loading (read-only)
// ---------------------------------------------------------------------------

async function loadExisting(plan: Plan): Promise<ExistingState> {
  const state: ExistingState = {
    userIdByEmail: new Map(),
    senderIds: new Set(),
    batchIds: new Set(),
    emailStatusById: new Map(),
    attemptIds: new Set(),
    outboxIds: new Set(),
  };

  const userEmails = plan.users.map((u) => u.email);
  if (userEmails.length > 0) {
    const rows = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(inArray(usersTable.email, userEmails));
    for (const row of rows) state.userIdByEmail.set(row.email, row.id);
  }

  const senderIdList = plan.senders.map((s) => s.id);
  if (senderIdList.length > 0) {
    const rows = await db
      .select({ id: sendersTable.id })
      .from(sendersTable)
      .where(inArray(sendersTable.id, senderIdList));
    for (const row of rows) state.senderIds.add(row.id);
  }

  const batchIdList = plan.batches.map((b) => b.id);
  if (batchIdList.length > 0) {
    const rows = await db
      .select({ id: emailBatchesTable.id })
      .from(emailBatchesTable)
      .where(inArray(emailBatchesTable.id, batchIdList));
    for (const row of rows) state.batchIds.add(row.id);
  }

  const emailIdList = plan.emails.map((e) => e.id);
  if (emailIdList.length > 0) {
    const rows = await db
      .select({ id: emailsTable.id, status: emailsTable.status })
      .from(emailsTable)
      .where(inArray(emailsTable.id, emailIdList));
    for (const row of rows) state.emailStatusById.set(row.id, row.status);
  }

  const attemptIdList = plan.attempts.map((a) => a.id);
  if (attemptIdList.length > 0) {
    const rows = await db
      .select({ id: sendAttemptsTable.id })
      .from(sendAttemptsTable)
      .where(inArray(sendAttemptsTable.id, attemptIdList));
    for (const row of rows) state.attemptIds.add(row.id);
  }

  const outboxIdList = plan.outbox.map((o) => o.id);
  if (outboxIdList.length > 0) {
    const rows = await db
      .select({ id: outboxEventsTable.id })
      .from(outboxEventsTable)
      .where(inArray(outboxEventsTable.id, outboxIdList));
    for (const row of rows) state.outboxIds.add(row.id);
  }

  return state;
}

function statusBreakdown(plan: Plan, state: ExistingState): Map<string, EntityCounts> {
  const byStatus = new Map<string, EntityCounts>();

  for (const email of plan.emails) {
    const entry = byStatus.get(email.status) ?? {
      planned: 0,
      inserted: 0,
      skipped: 0,
    };
    entry.planned += 1;
    if (state.emailStatusById.has(email.id)) {
      entry.skipped += 1;
    } else {
      entry.inserted += 1;
    }
    byStatus.set(email.status, entry);
  }

  return byStatus;
}

function describeState(plan: Plan, state: ExistingState): SeedSummary {
  const emailsInserted = plan.emails.filter(
    (e) => !state.emailStatusById.has(e.id),
  ).length;

  return {
    users: {
      planned: plan.users.length,
      inserted: plan.users.filter((u) => !state.userIdByEmail.has(u.email)).length,
      skipped: plan.users.filter((u) => state.userIdByEmail.has(u.email)).length,
    },
    senders: {
      planned: plan.senders.length,
      inserted: plan.senders.filter((s) => !state.senderIds.has(s.id)).length,
      skipped: plan.senders.filter((s) => state.senderIds.has(s.id)).length,
    },
    batches: {
      planned: plan.batches.length,
      inserted: plan.batches.filter((b) => !state.batchIds.has(b.id)).length,
      skipped: plan.batches.filter((b) => state.batchIds.has(b.id)).length,
    },
    emails: {
      planned: plan.emails.length,
      inserted: emailsInserted,
      skipped: plan.emails.length - emailsInserted,
    },
    attempts: {
      planned: plan.attempts.length,
      inserted: plan.attempts.filter((a) => !state.attemptIds.has(a.id)).length,
      skipped: plan.attempts.filter((a) => state.attemptIds.has(a.id)).length,
    },
    outbox: {
      planned: plan.outbox.length,
      inserted: plan.outbox.filter((o) => !state.outboxIds.has(o.id)).length,
      skipped: plan.outbox.filter((o) => state.outboxIds.has(o.id)).length,
    },
    emailsByStatus: statusBreakdown(plan, state),
  };
}

// ---------------------------------------------------------------------------
// Seeding (inside a single transaction)
// ---------------------------------------------------------------------------

async function seed(plan: Plan, state: ExistingState): Promise<SeedSummary> {
  // Snapshot the pre-seed state: `state` is mutated below to resolve ids, so
  // reporting must be based on what existed *before* this run.
  const before: ExistingState = {
    userIdByEmail: new Map(state.userIdByEmail),
    senderIds: new Set(state.senderIds),
    batchIds: new Set(state.batchIds),
    emailStatusById: new Map(state.emailStatusById),
    attemptIds: new Set(state.attemptIds),
    outboxIds: new Set(state.outboxIds),
  };

  return db.transaction(async (tx) => {
    // --- users (identity PK: reuse existing by unique email) ---
    const missingUsers = plan.users.filter(
      (u) => !state.userIdByEmail.has(u.email),
    );
    if (missingUsers.length > 0) {
      await tx
        .insert(usersTable)
        .values(
          missingUsers.map((u) => ({ name: u.name, age: u.age, email: u.email })),
        )
        .onConflictDoNothing();

      const rows = await tx
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.email, missingUsers.map((u) => u.email)));
      for (const row of rows) state.userIdByEmail.set(row.email, row.id);
    }

    const userIdOf = (userKey: string): number => {
      const user = plan.users.find((u) => u.key === userKey);
      if (!user) throw new Error(`Unknown planned user ${userKey}`);
      const id = state.userIdByEmail.get(user.email);
      if (id === undefined) {
        throw new Error(`Could not resolve userId for ${userKey}`);
      }
      return id;
    };

    // --- senders ---
    const missingSenders = plan.senders.filter((s) => !state.senderIds.has(s.id));
    if (missingSenders.length > 0) {
      await tx
        .insert(sendersTable)
        .values(
          missingSenders.map((s) => ({
            id: s.id,
            userId: userIdOf(s.userKey),
            fromName: s.fromName,
            fromEmail: s.fromEmail,
            hourlyLimit: s.hourlyLimit,
            isActive: s.isActive,
            slackWebhookUrl: s.slackWebhookUrl,
            slackConnectedAt: s.slackConnectedAt,
            createdAt: s.createdAt,
          })),
        )
        .onConflictDoNothing();
    }

    // --- email batches ---
    const missingBatches = plan.batches.filter(
      (b) => !state.batchIds.has(b.id),
    );
    if (missingBatches.length > 0) {
      await tx
        .insert(emailBatchesTable)
        .values(
          missingBatches.map((b) => ({
            id: b.id,
            userId: userIdOf(b.userKey),
            senderId: b.senderId,
            subject: b.subject,
            body: b.body,
            startAt: b.startAt,
            delayMs: b.delayMs,
            hourlyLimit: b.hourlyLimit,
            totalEmails: b.totalEmails,
            createdAt: b.createdAt,
          })),
        )
        .onConflictDoNothing();
    }

    // --- emails ---
    const missingEmails = plan.emails.filter(
      (e) => !state.emailStatusById.has(e.id),
    );
    if (missingEmails.length > 0) {
      await tx
        .insert(emailsTable)
        .values(
          missingEmails.map((e) => ({
            id: e.id,
            batchId: e.batchId,
            senderId: e.senderId,
            recipient: e.recipient,
            subject: e.subject,
            body: e.body,
            scheduledAt: e.scheduledAt,
            status: e.status,
            idempotencyKey: e.idempotencyKey,
            sentAt: e.sentAt,
            providerMessageId: e.providerMessageId,
            lastError: e.lastError,
            createdAt: e.createdAt,
            updatedAt: e.updatedAt,
          })),
        )
        .onConflictDoNothing();

      const rows = await tx
        .select({ id: emailsTable.id, status: emailsTable.status })
        .from(emailsTable)
        .where(inArray(emailsTable.id, missingEmails.map((e) => e.id)));
      for (const row of rows) state.emailStatusById.set(row.id, row.status);
    }

    // --- send attempts ---
    const missingAttempts = plan.attempts.filter(
      (a) => !state.attemptIds.has(a.id),
    );
    if (missingAttempts.length > 0) {
      await tx
        .insert(sendAttemptsTable)
        .values(
          missingAttempts.map((a) => ({
            id: a.id,
            emailId: a.emailId,
            attemptNumber: a.attemptNumber,
            status: a.status,
            providerMessageId: a.providerMessageId,
            error: a.error,
            attemptedAt: a.attemptedAt,
          })),
        )
        .onConflictDoNothing();
    }

    // --- outbox events ---
    const missingOutbox = plan.outbox.filter((o) => !state.outboxIds.has(o.id));
    if (missingOutbox.length > 0) {
      await tx
        .insert(outboxEventsTable)
        .values(
          missingOutbox.map((o) => ({
            id: o.id,
            eventType: o.eventType,
            aggregateType: o.aggregateType,
            aggregateId: o.aggregateId,
            payload: o.payload,
            status: o.status,
            attempts: o.attempts,
            availableAt: o.availableAt,
            processedAt: o.processedAt,
            lastError: o.lastError,
            createdAt: o.createdAt,
          })),
        )
        .onConflictDoNothing();
    }

    return describeState(plan, before);
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSummary(summary: SeedSummary, mode: string): void {
  const line = (label: string, c: EntityCounts): string =>
    `  ${label.padEnd(12)} planned=${String(c.planned).padEnd(5)} inserted=${String(
      c.inserted,
    ).padEnd(5)} skipped=${c.skipped}`;

  logger.info(`\nSeed summary (${mode}):`);
  logger.info(line("users", summary.users));
  logger.info(line("senders", summary.senders));
  logger.info(line("batches", summary.batches));
  logger.info(line("emails", summary.emails));
  logger.info(line("attempts", summary.attempts));
  logger.info(line("outbox", summary.outbox));

  logger.info("\nEmails by status:");
  for (const status of ["scheduled", "sent", "failed", "sending", "unknown"]) {
    const c = summary.emailsByStatus.get(status);
    if (!c) continue;
    logger.info(
      `  ${status.padEnd(10)} planned=${String(c.planned).padEnd(5)} inserted=${String(
        c.inserted,
      ).padEnd(5)} skipped=${c.skipped}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Enqueue (Mode B, opt-in)
// ---------------------------------------------------------------------------

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`timed out after ${ms}ms`);
    }),
  ]);
}

type EmailQueueModule = typeof import("../queue/email.queue.js");
type RedisConnection = (typeof import("../utils/email.redis.js"))["default"];

/**
 * Pre-flight Redis with a throwaway, non-retrying client so a down Redis fails
 * fast. Importing the BullMQ queue module would otherwise retry forever and
 * keep the process alive.
 */
async function probeRedis(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;

  const { Redis } = await import("ioredis");
  const client = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: () => null,
  });
  client.on("error", () => undefined);

  try {
    await withTimeout(
      client.connect().then(() => client.ping()),
      4000,
    );
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

async function runEnqueue(plan: Plan): Promise<void> {
  const candidates = plan.emails.filter(
    (e) => e.status === "scheduled" && ENQUEUE_SAFE_BATCH_KEYS.has(e.batchKey),
  );

  if (candidates.length === 0) {
    logger.info("\n--enqueue: no safe scheduled candidates found; nothing queued.");
    return;
  }

  if (!(await probeRedis())) {
    logger.warn(
      "\n--enqueue: Redis is not reachable — skipping queue integration. " +
        "Database fixtures were still seeded.",
    );
    return;
  }

  let emailQueue: EmailQueueModule["emailQueue"] | null = null;
  let redis: RedisConnection | null = null;

  try {
    const queueModule = await import("../queue/email.queue.js");
    const connectionModule = await import("../utils/email.redis.js");
    emailQueue = queueModule.emailQueue;
    redis = connectionModule.default;

    // Re-verify the live status right before publishing: only still-scheduled rows.
    const ids = candidates.map((c) => c.id);
    const rows = await db
      .select({
        id: emailsTable.id,
        status: emailsTable.status,
        scheduledAt: emailsTable.scheduledAt,
      })
      .from(emailsTable)
      .where(inArray(emailsTable.id, ids));

    const scheduledNow = new Map(
      rows
        .filter((r) => r.status === "scheduled")
        .map((r) => [r.id, r.scheduledAt]),
    );

    let enqueued = 0;
    for (const candidate of candidates) {
      const scheduledAt = scheduledNow.get(candidate.id);
      if (!scheduledAt) continue; // Not scheduled anymore (worker already touched it).

      const jobDelay = Math.max(0, scheduledAt.getTime() - Date.now());

      await emailQueue.add(
        "send-email",
        { emailId: candidate.id },
        { jobId: candidate.id, delay: jobDelay },
      );
      enqueued += 1;
    }

    logger.info(`\n--enqueue: published ${enqueued} job(s) with deterministic jobIds.`);
    logger.warn(
      "WARNING: starting the worker now will send real test emails through Ethereal SMTP.",
    );
  } catch (error) {
    logger.warn(
      "\n--enqueue: queue integration failed — " +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (emailQueue) {
      await emailQueue.close().catch(() => undefined);
    }
    // Force-close: a strict quit() can hang while the socket reconnects.
    redis?.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    printUsage();
    return 1;
  }

  if (args.help) {
    printUsage();
    return 0;
  }

  assertSafetyGates();

  const plan = buildPlan(args.count);
  validatePlan(plan);

  const existing = await loadExisting(plan);

  if (args.dryRun) {
    const summary = describeState(plan, existing);
    printSummary(summary, "dry-run — nothing written");
    logger.info(
      "\nDry run only: no database writes, no Redis calls, no emails sent.",
    );
    return 0;
  }

  const summary = await seed(plan, existing);
  printSummary(summary, "live");

  if (args.enqueue) {
    await runEnqueue(plan);
  } else {
    logger.info(
      "\nMode A (database fixtures only): Redis untouched, no emails sent.",
    );
  }

  return 0;
}

main()
  .then(async (code) => {
    await db.$client.end().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    logger.error("Seed failed", { error: serializeError(error) });
    await db.$client.end().catch(() => undefined);
    process.exit(1);
  });
