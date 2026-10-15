import { eq } from "drizzle-orm";
import db from "../db/index.js";
import {
  emailBatchesTable,
  emailsTable,
  outboxEventsTable,
  usersTable,
} from "../db/schema.js";
import type { CreateBatchInput } from "../validators/batch.validator.js";

export type EmailBatch = typeof emailBatchesTable.$inferSelect;
export type ScheduledEmail = typeof emailsTable.$inferSelect;

export interface ScheduledBatchResult {
  batch: EmailBatch;
  emails: ScheduledEmail[];
}


export async function createEmailBatch(
  input: CreateBatchInput,
): Promise<ScheduledBatchResult | null> {
  const {
    userId,
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
      return null;
    }

    const [batch] = await tx
      .insert(emailBatchesTable)
      .values({
        userId,
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

    const createdEmails: ScheduledEmail[] = [];

    for (const [index, recipient] of recipients.entries()) {
      const scheduledAt = new Date(startAt.getTime() + index * delayMs);

      const [email] = await tx
        .insert(emailsTable)
        .values({
          batchId: batch.id,
          recipient,
          subject: trimmedSubject,
          body,
          scheduledAt,
          status: "scheduled",
          idempotencyKey: `${idempotencyKey}:${index}`,
        })
        .returning();

      if (!email) {
        throw new Error("Failed to create scheduled email");
      }

      await tx.insert(outboxEventsTable).values({
        eventType: "email.schedule",
        aggregateType: "email",
        aggregateId: email.id,
        payload: {
          emailId: email.id,
          batchId: batch.id,
        },
        status: "pending",
      });

      createdEmails.push(email);
    }

    return { batch, emails: createdEmails };
  });
}

/**
 * Looks up a previously created batch via the first email's idempotency
 * key. Used to answer replayed requests without creating duplicates.
 */
export async function findExistingBatch(
  idempotencyKey: string,
): Promise<ScheduledBatchResult | null> {
  const [existingEmail] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.idempotencyKey, `${idempotencyKey}:0`))
    .limit(1);

  if (!existingEmail) {
    return null;
  }

  const [batch] = await db
    .select()
    .from(emailBatchesTable)
    .where(eq(emailBatchesTable.id, existingEmail.batchId))
    .limit(1);

  if (!batch) {
    return null;
  }

  const emails = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.batchId, existingEmail.batchId));

  return { batch, emails };
}
