import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import db from "../../src/db/index.js";
import {
  emailBatchesTable,
  emailsTable,
  outboxEventsTable,
  sendAttemptsTable,
  sendersTable,
  usersTable,
} from "../../src/db/schema.js";

/**
 * Creates and tears down isolated test data. Every row this helper creates is
 * namespaced and deleted afterwards; shared tables are never truncated.
 */

let sequence = 0;

function uniqueSuffix(): string {
  sequence += 1;
  return `${randomUUID().slice(0, 8)}-${sequence}`;
}

export interface TestUser {
  id: number;
  email: string;
}

export async function createTestUser(
  overrides: Partial<{ name: string; age: number; tenantHourlyLimit: number }> = {},
): Promise<TestUser> {
  const email = `test-${uniqueSuffix()}@api-test.example.com`;

  const [row] = await db
    .insert(usersTable)
    .values({
      name: overrides.name ?? "API Test User",
      age: overrides.age ?? 30,
      email,
      tenantHourlyLimit: overrides.tenantHourlyLimit ?? 100,
    })
    .returning({ id: usersTable.id, email: usersTable.email });

  if (!row) {
    throw new Error("Failed to create test user");
  }

  return row;
}

export interface TestSender {
  id: string;
  userId: number;
  fromEmail: string;
  isActive: boolean;
}

export async function createTestSender(
  userId: number,
  overrides: Partial<{ isActive: boolean; hourlyLimit: number; fromName: string }> = {},
): Promise<TestSender> {
  const [row] = await db
    .insert(sendersTable)
    .values({
      userId,
      fromName: overrides.fromName ?? "API Test Sender",
      fromEmail: `sender-${uniqueSuffix()}@api-test.example.com`,
      hourlyLimit: overrides.hourlyLimit ?? 500,
      isActive: overrides.isActive ?? true,
    })
    .returning({
      id: sendersTable.id,
      userId: sendersTable.userId,
      fromEmail: sendersTable.fromEmail,
      isActive: sendersTable.isActive,
    });

  if (!row) {
    throw new Error("Failed to create test sender");
  }

  return row;
}

export interface TestBatch {
  id: string;
  userId: number;
  senderId: string | null;
}

export async function insertTestBatch(
  input: {
    userId: number;
    senderId: string | null;
    subject?: string;
    totalEmails?: number;
  },
): Promise<TestBatch> {
  const [row] = await db
    .insert(emailBatchesTable)
    .values({
      userId: input.userId,
      senderId: input.senderId,
      subject: input.subject ?? `Fixture ${uniqueSuffix()}`,
      body: "Fixture body {{name}}",
      startAt: new Date(Date.now() + 60_000),
      delayMs: 1000,
      hourlyLimit: 100,
      totalEmails: input.totalEmails ?? 0,
    })
    .returning({
      id: emailBatchesTable.id,
      userId: emailBatchesTable.userId,
      senderId: emailBatchesTable.senderId,
    });

  if (!row) {
    throw new Error("Failed to create test batch");
  }

  return row;
}

export interface TestEmail {
  id: string;
  idempotencyKey: string;
}

export async function insertTestEmail(input: {
  batchId: string;
  senderId: string | null;
  status?: string;
  recipient?: string;
  idempotencyKey?: string;
  scheduledAt?: Date;
  sentAt?: Date | null;
  lastError?: string | null;
  providerMessageId?: string | null;
}): Promise<TestEmail> {
  const [row] = await db
    .insert(emailsTable)
    .values({
      batchId: input.batchId,
      senderId: input.senderId,
      recipient: input.recipient ?? `recipient-${uniqueSuffix()}@api-test.example.com`,
      recipientName: null,
      subject: "Fixture subject",
      body: "Fixture body",
      scheduledAt: input.scheduledAt ?? new Date(Date.now() + 60_000),
      status: input.status ?? "scheduled",
      idempotencyKey: input.idempotencyKey ?? `fixture-${uniqueSuffix()}:0`,
      sentAt: input.sentAt ?? null,
      lastError: input.lastError ?? null,
      providerMessageId: input.providerMessageId ?? null,
    })
    .returning({ id: emailsTable.id, idempotencyKey: emailsTable.idempotencyKey });

  if (!row) {
    throw new Error("Failed to create test email");
  }

  return row;
}

/** Deletes every row created for a test user (children first). */
export async function cleanupTestUser(userId: number): Promise<void> {
  const batchRows = await db
    .select({ id: emailBatchesTable.id })
    .from(emailBatchesTable)
    .where(eq(emailBatchesTable.userId, userId));

  const batchIds = batchRows.map((row) => row.id);

  if (batchIds.length > 0) {
    const emailRows = await db
      .select({ id: emailsTable.id })
      .from(emailsTable)
      .where(inArray(emailsTable.batchId, batchIds));

    const emailIds = emailRows.map((row) => row.id);

    if (emailIds.length > 0) {
      await db
        .delete(outboxEventsTable)
        .where(inArray(outboxEventsTable.aggregateId, emailIds));
      await db
        .delete(sendAttemptsTable)
        .where(inArray(sendAttemptsTable.emailId, emailIds));
      await db.delete(emailsTable).where(inArray(emailsTable.id, emailIds));
    }

    await db
      .delete(emailBatchesTable)
      .where(inArray(emailBatchesTable.id, batchIds));
  }

  await db.delete(sendersTable).where(eq(sendersTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
}

export interface StoredEmail {
  id: string;
  recipient: string;
  recipientName: string | null;
  subject: string;
  body: string;
  status: string;
  idempotencyKey: string;
  scheduledAt: Date;
}

/** Loads every email of a batch in insertion order (idempotency key index). */
export async function getEmailsForBatch(
  batchId: string,
): Promise<StoredEmail[]> {
  return db
    .select({
      id: emailsTable.id,
      recipient: emailsTable.recipient,
      recipientName: emailsTable.recipientName,
      subject: emailsTable.subject,
      body: emailsTable.body,
      status: emailsTable.status,
      idempotencyKey: emailsTable.idempotencyKey,
      scheduledAt: emailsTable.scheduledAt,
    })
    .from(emailsTable)
    .where(eq(emailsTable.batchId, batchId))
    .orderBy(emailsTable.idempotencyKey);
}

/** Counts `email.schedule` outbox events attached to a batch's emails. */
export async function countOutboxEventsForBatch(batchId: string): Promise<number> {
  const emailRows = await db
    .select({ id: emailsTable.id })
    .from(emailsTable)
    .where(eq(emailsTable.batchId, batchId));

  const emailIds = emailRows.map((row) => row.id);

  if (emailIds.length === 0) {
    return 0;
  }

  const rows = await db
    .select({ id: outboxEventsTable.id, eventType: outboxEventsTable.eventType })
    .from(outboxEventsTable)
    .where(inArray(outboxEventsTable.aggregateId, emailIds));

  return rows.filter((row) => row.eventType === "email.schedule").length;
}

/** Removes the outbox events for a batch's emails (to test repair paths). */
export async function deleteOutboxEventsForBatch(batchId: string): Promise<number> {
  const emailRows = await db
    .select({ id: emailsTable.id })
    .from(emailsTable)
    .where(eq(emailsTable.batchId, batchId));

  const emailIds = emailRows.map((row) => row.id);

  if (emailIds.length === 0) {
    return 0;
  }

  const deleted = await db
    .delete(outboxEventsTable)
    .where(inArray(outboxEventsTable.aggregateId, emailIds))
    .returning({ id: outboxEventsTable.id });

  return deleted.length;
}

/** Updates the status of every email in a batch. */
export async function setBatchEmailStatus(
  batchId: string,
  status: string,
): Promise<void> {
  await db
    .update(emailsTable)
    .set({ status })
    .where(eq(emailsTable.batchId, batchId));
}

/** Counts email_batches rows with an exact subject (uniqueness assertions). */
export async function countBatchesBySubject(subject: string): Promise<number> {
  const rows = await db
    .select({ id: emailBatchesTable.id })
    .from(emailBatchesTable)
    .where(eq(emailBatchesTable.subject, subject));

  return rows.length;
}

/** Counts emails with an exact idempotency key (rollback assertions). */
export async function countEmailsByIdempotencyKey(
  idempotencyKey: string,
): Promise<number> {
  const rows = await db
    .select({ id: emailsTable.id })
    .from(emailsTable)
    .where(eq(emailsTable.idempotencyKey, idempotencyKey));

  return rows.length;
}
