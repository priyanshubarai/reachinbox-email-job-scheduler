import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import db from "../db/index.js";
import {
  emailBatchesTable,
  emailsTable,
  outboxEventsTable,
  sendersTable,
  usersTable,
} from "../db/schema.js";
import { conflict, notFound, unauthenticated } from "../lib/errors.js";
import { renderSubjectAndBody } from "../utils/template.js";
import { toPagination } from "../validators/common.validator.js";
import type { ListBatchesQuery, Recipient } from "../validators/batch.validator.js";

export type EmailBatch = typeof emailBatchesTable.$inferSelect;
export type ScheduledEmail = typeof emailsTable.$inferSelect;
export type SenderRow = typeof sendersTable.$inferSelect;

export interface ScheduledBatchResult {
  batch: EmailBatch;
  emails: ScheduledEmail[];
}

export interface CreateEmailBatchInput {
  userId: number;
  senderId: string;
  subject: string;
  body: string;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  recipients: Recipient[];
  idempotencyKey: string;
}

export interface PublicSender {
  id: string;
  fromName: string;
  fromEmail: string;
  hourlyLimit: number;
  isActive: boolean;
}

export interface StatusCounts {
  scheduled: number;
  sending: number;
  sent: number;
  failed: number;
  unknown: number;
  total: number;
}

export interface BatchWithCounts {
  batch: EmailBatch;
  deliveryCounts: StatusCounts;
}

const OUTBOX_EVENT_TYPE = "email.schedule";
const LIVE_OUTBOX_STATUSES = ["pending", "processed"] as const;

/**
 * Stored idempotency keys are namespaced by user id and recipient index.
 *
 * `emails.idempotencyKey` is globally unique, but an idempotency key belongs to
 * one account: two users may legitimately choose the same client key (for
 * example `demo-1`) without colliding. Prefixing with the user id keeps replay
 * detection per-account while still guaranteeing one row per (user, key, index).
 *
 * Result fits `varchar(255)`: userId (<=10) + 1 + key (<=200) + 1 + index (<=4).
 */
export function buildEmailIdempotencyKey(
  userId: number,
  idempotencyKey: string,
  index: number,
): string {
  return `${userId}:${idempotencyKey}:${index}`;
}

export function emptyStatusCounts(): StatusCounts {
  return { scheduled: 0, sending: 0, sent: 0, failed: 0, unknown: 0, total: 0 };
}

function addStatusCount(counts: StatusCounts, status: string, value: number): void {
  counts.total += value;

  switch (status) {
    case "scheduled":
      counts.scheduled += value;
      break;
    case "sending":
      counts.sending += value;
      break;
    case "sent":
      counts.sent += value;
      break;
    case "failed":
      counts.failed += value;
      break;
    case "unknown":
      counts.unknown += value;
      break;
    default:
      break;
  }
}

/** Groups delivery counts by batch id from a single aggregate result set. */
async function loadStatusCounts(
  batchIds: string[],
): Promise<Map<string, StatusCounts>> {
  const result = new Map<string, StatusCounts>();

  if (batchIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      batchId: emailsTable.batchId,
      status: emailsTable.status,
      value: count(),
    })
    .from(emailsTable)
    .where(inArray(emailsTable.batchId, batchIds))
    .groupBy(emailsTable.batchId, emailsTable.status);

  for (const row of rows) {
    const counts = result.get(row.batchId) ?? emptyStatusCounts();
    addStatusCount(counts, row.status, Number(row.value));
    result.set(row.batchId, counts);
  }

  return result;
}

function toPublicSender(sender: SenderRow): PublicSender {
  return {
    id: sender.id,
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    hourlyLimit: sender.hourlyLimit,
    isActive: sender.isActive,
  };
}

/**
 * Creates a batch, its scheduled emails and the matching `email.schedule`
 * outbox events inside a single transaction. No BullMQ job is ever enqueued
 * here; the transactional outbox dispatcher does that.
 */
export async function createEmailBatch(
  input: CreateEmailBatchInput,
): Promise<ScheduledBatchResult> {
  const {
    userId,
    senderId,
    subject,
    body,
    startAt,
    delayMs,
    hourlyLimit,
    recipients,
    idempotencyKey,
  } = input;

  const trimmedSubject = subject.trim();

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      // The authenticated identity does not resolve to a stored user.
      throw unauthenticated("The authenticated user no longer exists");
    }

    const [sender] = await tx
      .select()
      .from(sendersTable)
      .where(eq(sendersTable.id, senderId))
      .limit(1);

    // A sender owned by another user must look indistinguishable from missing.
    if (!sender || sender.userId !== userId) {
      throw notFound("Sender not found");
    }

    if (!sender.isActive) {
      throw conflict("Sender is inactive and cannot send email");
    }

    const [batch] = await tx
      .insert(emailBatchesTable)
      .values({
        userId,
        senderId,
        subject: trimmedSubject,
        body,
        startAt,
        delayMs,
        hourlyLimit,
        totalEmails: recipients.length,
      })
      .returning();

    if (!batch) {
      throw new Error("Failed to create email batch");
    }

    const emailValues = recipients.map((recipient, index) => {
      const rendered = renderSubjectAndBody(trimmedSubject, body, {
        name: recipient.name,
        email: recipient.email,
      });

      return {
        batchId: batch.id,
        senderId,
        recipient: recipient.email,
        recipientName: recipient.name,
        subject: rendered.subject,
        body: rendered.body,
        scheduledAt: new Date(startAt.getTime() + index * delayMs),
        status: "scheduled",
        idempotencyKey: buildEmailIdempotencyKey(userId, idempotencyKey, index),
      };
    });

    const createdEmails = await tx
      .insert(emailsTable)
      .values(emailValues)
      .returning();

    await tx.insert(outboxEventsTable).values(
      createdEmails.map((email) => ({
        eventType: OUTBOX_EVENT_TYPE,
        aggregateType: "email",
        aggregateId: email.id,
        payload: { emailId: email.id, batchId: batch.id },
        status: "pending",
      })),
    );

    return { batch, emails: createdEmails };
  });
}

/**
 * Looks up a previously created batch via the first email's idempotency key,
 * scoped to the caller so one user can never observe another user's batch.
 */
export async function findExistingBatch(
  idempotencyKey: string,
  userId: number,
): Promise<ScheduledBatchResult | null> {
  const [existingEmail] = await db
    .select({ batchId: emailsTable.batchId })
    .from(emailsTable)
    .innerJoin(
      emailBatchesTable,
      eq(emailsTable.batchId, emailBatchesTable.id),
    )
    .where(
      and(
        eq(
          emailsTable.idempotencyKey,
          buildEmailIdempotencyKey(userId, idempotencyKey, 0),
        ),
        eq(emailBatchesTable.userId, userId),
      ),
    )
    .limit(1);

  if (!existingEmail) {
    return null;
  }

  const [batch] = await db
    .select()
    .from(emailBatchesTable)
    .where(
      and(
        eq(emailBatchesTable.id, existingEmail.batchId),
        eq(emailBatchesTable.userId, userId),
      ),
    )
    .limit(1);

  if (!batch) {
    return null;
  }

  const emails = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.batchId, batch.id));

  return { batch, emails };
}

export interface PaginatedBatches {
  rows: BatchWithCounts[];
  total: number;
  page: number;
  limit: number;
}

/** Lists batches for a user with delivery counts, newest first. */
export async function listBatches(
  userId: number,
  query: ListBatchesQuery,
): Promise<PaginatedBatches> {
  const { page, limit, offset } = toPagination(query.page, query.limit);
  const conditions = [eq(emailBatchesTable.userId, userId)];

  if (query.senderId) {
    conditions.push(eq(emailBatchesTable.senderId, query.senderId));
  }

  if (query.createdFrom) {
    conditions.push(gte(emailBatchesTable.createdAt, query.createdFrom));
  }

  if (query.createdTo) {
    conditions.push(lte(emailBatchesTable.createdAt, query.createdTo));
  }

  const where = and(...conditions);

  const [totals] = await db
    .select({ value: count() })
    .from(emailBatchesTable)
    .where(where);

  const batches = await db
    .select()
    .from(emailBatchesTable)
    .where(where)
    // `id` breaks ties so ordering is stable across pages.
    .orderBy(desc(emailBatchesTable.createdAt), desc(emailBatchesTable.id))
    .limit(limit)
    .offset(offset);

  const countsByBatch = await loadStatusCounts(batches.map((b) => b.id));

  return {
    rows: batches.map((batch) => ({
      batch,
      deliveryCounts: countsByBatch.get(batch.id) ?? emptyStatusCounts(),
    })),
    total: Number(totals?.value ?? 0),
    page,
    limit,
  };
}

export interface BatchDetail extends BatchWithCounts {
  sender: PublicSender | null;
}

/** Returns a single batch with sender + delivery counts, or null if not owned. */
export async function getBatchById(
  userId: number,
  batchId: string,
): Promise<BatchDetail | null> {
  const [batch] = await db
    .select()
    .from(emailBatchesTable)
    .where(
      and(
        eq(emailBatchesTable.id, batchId),
        eq(emailBatchesTable.userId, userId),
      ),
    )
    .limit(1);

  if (!batch) {
    return null;
  }

  const [senderRows, countsByBatch] = await Promise.all([
    batch.senderId
      ? db
          .select()
          .from(sendersTable)
          .where(eq(sendersTable.id, batch.senderId))
          .limit(1)
      : Promise.resolve([] as SenderRow[]),
    loadStatusCounts([batch.id]),
  ]);

  const sender = senderRows[0] ? toPublicSender(senderRows[0]) : null;

  return {
    batch,
    sender,
    deliveryCounts: countsByBatch.get(batch.id) ?? emptyStatusCounts(),
  };
}

export interface ScheduleBatchResult {
  batchId: string;
  totalEmails: number;
  eligible: number;
  alreadyScheduled: number;
  newlyScheduled: number;
  ineligible: number;
}

/**
 * Idempotently (re)arms delivery for a batch.
 *
 * The schema has no "draft" batch state: emails are created `scheduled` with
 * their outbox events already written. This endpoint therefore guarantees that
 * every eligible email (`status = 'scheduled'`) has exactly one live
 * `email.schedule` outbox event, creating only the missing ones. It is what
 * recovers a batch whose events were lost, and it never duplicates events or
 * queue jobs on repeated calls.
 *
 * A row lock on the batch serializes concurrent calls for the same batch.
 */
export async function scheduleBatch(
  userId: number,
  batchId: string,
): Promise<ScheduleBatchResult> {
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(emailBatchesTable)
      .where(
        and(
          eq(emailBatchesTable.id, batchId),
          eq(emailBatchesTable.userId, userId),
        ),
      )
      .for("update")
      .limit(1);

    if (!batch) {
      throw notFound("Batch not found");
    }

    const eligibleEmails = await tx
      .select({ id: emailsTable.id })
      .from(emailsTable)
      .where(
        and(
          eq(emailsTable.batchId, batchId),
          eq(emailsTable.status, "scheduled"),
        ),
      );

    const eligibleIds = eligibleEmails.map((email) => email.id);

    const alreadyArmed = new Set<string>();

    if (eligibleIds.length > 0) {
      const events = await tx
        .select({
          aggregateId: outboxEventsTable.aggregateId,
          status: outboxEventsTable.status,
        })
        .from(outboxEventsTable)
        .where(
          and(
            eq(outboxEventsTable.eventType, OUTBOX_EVENT_TYPE),
            inArray(outboxEventsTable.aggregateId, eligibleIds),
          ),
        );

      for (const event of events) {
        if (
          (LIVE_OUTBOX_STATUSES as readonly string[]).includes(event.status)
        ) {
          alreadyArmed.add(event.aggregateId);
        }
      }
    }

    const toCreate = eligibleIds.filter((id) => !alreadyArmed.has(id));

    if (toCreate.length > 0) {
      await tx.insert(outboxEventsTable).values(
        toCreate.map((emailId) => ({
          eventType: OUTBOX_EVENT_TYPE,
          aggregateType: "email",
          aggregateId: emailId,
          payload: { emailId, batchId },
          status: "pending",
        })),
      );
    }

    return {
      batchId,
      totalEmails: batch.totalEmails,
      eligible: eligibleIds.length,
      alreadyScheduled: alreadyArmed.size,
      newlyScheduled: toCreate.length,
      ineligible: Math.max(0, batch.totalEmails - eligibleIds.length),
    };
  });
}
