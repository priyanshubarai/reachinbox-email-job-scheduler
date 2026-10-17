import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import db from "../../src/db/index.js";
import {
  emailBatchesTable,
  emailsTable,
  sendersTable,
  usersTable,
} from "../../src/db/schema.js";

/**
 * A complete, isolated rate-limit scope: one user (tenant), one sender, one
 * batch and one scheduled email. Every id is unique, so cleanup can always be
 * narrowed down to exactly these rows.
 */
export interface Fixture {
  userId: number;
  senderId: string;
  batchId: string;
  emailId: string;
  idempotencyKey: string;
}

export interface FixtureLimits {
  tenantHourlyLimit: number;
  senderHourlyLimit: number;
  /** Number of extra scheduled emails in the same batch (default 0). */
  extraEmails?: number;
}

/**
 * Creates the rows the real worker reads (batch -> user -> sender quotas) plus
 * one scheduled email. No outbox rows are written, so the outbox dispatcher is
 * never involved and nothing is enqueued implicitly.
 */
export async function createFixture(
  limits: FixtureLimits,
): Promise<Fixture> {
  const slug = randomUUID();
  const slugShort = slug.slice(0, 8);

  const [user] = await db
    .insert(usersTable)
    .values({
      name: `rl-test-${slugShort}`,
      age: 30,
      email: `rl-test-${slug}@example.test`,
      tenantHourlyLimit: limits.tenantHourlyLimit,
    })
    .returning({ id: usersTable.id });

  if (!user) {
    throw new Error("failed to insert test user");
  }

  const [sender] = await db
    .insert(sendersTable)
    .values({
      userId: user.id,
      fromName: "RL Test Sender",
      fromEmail: `rl-test-${slug}@example.test`,
      hourlyLimit: limits.senderHourlyLimit,
      isActive: true,
      slackWebhookUrl: null,
    })
    .returning({ id: sendersTable.id });

  if (!sender) {
    throw new Error("failed to insert test sender");
  }

  const totalEmails = 1 + (limits.extraEmails ?? 0);

  const [batch] = await db
    .insert(emailBatchesTable)
    .values({
      userId: user.id,
      senderId: sender.id,
      subject: "RL test batch",
      body: "RL test batch body",
      startAt: new Date(),
      delayMs: 0,
      hourlyLimit: limits.senderHourlyLimit,
      totalEmails,
    })
    .returning({ id: emailBatchesTable.id });

  if (!batch) {
    throw new Error("failed to insert test batch");
  }

  const idempotencyKey = `rl-test-${slug}`;
  const [email] = await db
    .insert(emailsTable)
    .values({
      batchId: batch.id,
      senderId: sender.id,
      recipient: `rl-recipient-${slug}@example.test`,
      subject: "RL test email",
      body: "RL test email body",
      scheduledAt: new Date(),
      status: "scheduled",
      idempotencyKey,
    })
    .returning({ id: emailsTable.id });

  if (!email) {
    throw new Error("failed to insert test email");
  }

  return {
    userId: user.id,
    senderId: sender.id,
    batchId: batch.id,
    emailId: email.id,
    idempotencyKey,
  };
}

/** Reads an email row by id (for status assertions). */
export async function getEmail(emailId: string) {
  const [row] = await db
    .select()
    .from(emailsTable)
    .where(eq(emailsTable.id, emailId))
    .limit(1);
  return row ?? null;
}

/** Deletes only the rows this test created, child-first for FK order. */
export async function removeFixture(fixture: Fixture): Promise<void> {
  await db
    .delete(emailsTable)
    .where(eq(emailsTable.id, fixture.emailId));
  await db
    .delete(emailBatchesTable)
    .where(eq(emailBatchesTable.id, fixture.batchId));
  await db
    .delete(sendersTable)
    .where(eq(sendersTable.id, fixture.senderId));
  await db.delete(usersTable).where(eq(usersTable.id, fixture.userId));
}

/** Closes the shared drizzle/Neon client so the test process can exit. */
export async function closeDb(): Promise<void> {
  const client = (db as unknown as { $client?: { end?: () => Promise<void> } })
    .$client;
  if (client?.end) {
    await client.end();
  }
}
