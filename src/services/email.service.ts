import { and, count, desc, eq } from "drizzle-orm";
import db from "../db/index.js";
import { emailBatchesTable, emailsTable } from "../db/schema.js";
import { sanitizeErrorText } from "../utils/sanitize-error.js";
import { toPagination } from "../validators/common.validator.js";
import type { ListEmailsQuery } from "../validators/email.validator.js";

export interface EmailListItem {
  id: string;
  batchId: string;
  senderId: string | null;
  recipient: string;
  recipientName: string | null;
  subject: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailDetail extends EmailListItem {
  providerMessageId: string | null;
}

export interface PaginatedEmails {
  rows: EmailListItem[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Columns safe to expose in list responses. Deliberately excludes `body` (the
 * full message payload) and never returns credential material.
 */
const listColumns = {
  id: emailsTable.id,
  batchId: emailsTable.batchId,
  senderId: emailsTable.senderId,
  recipient: emailsTable.recipient,
  recipientName: emailsTable.recipientName,
  subject: emailsTable.subject,
  status: emailsTable.status,
  scheduledAt: emailsTable.scheduledAt,
  sentAt: emailsTable.sentAt,
  lastError: emailsTable.lastError,
  createdAt: emailsTable.createdAt,
  updatedAt: emailsTable.updatedAt,
};

function withSafeError<T extends { lastError: string | null }>(
  row: T,
): Omit<T, "lastError"> & { lastError: string | null } {
  return { ...row, lastError: sanitizeErrorText(row.lastError) };
}

/**
 * Lists a user's emails. Ownership is enforced by joining the parent batch
 * (emails do not carry a user id of their own).
 */
export async function listEmails(
  userId: number,
  query: ListEmailsQuery,
): Promise<PaginatedEmails> {
  const { page, limit, offset } = toPagination(query.page, query.limit);
  const conditions = [eq(emailBatchesTable.userId, userId)];

  if (query.batchId) {
    conditions.push(eq(emailsTable.batchId, query.batchId));
  }

  if (query.senderId) {
    conditions.push(eq(emailsTable.senderId, query.senderId));
  }

  if (query.status) {
    conditions.push(eq(emailsTable.status, query.status));
  }

  if (query.recipient) {
    conditions.push(eq(emailsTable.recipient, query.recipient));
  }

  const where = and(...conditions);

  const [totals] = await db
    .select({ value: count() })
    .from(emailsTable)
    .innerJoin(emailBatchesTable, eq(emailsTable.batchId, emailBatchesTable.id))
    .where(where);

  const rows = await db
    .select(listColumns)
    .from(emailsTable)
    .innerJoin(emailBatchesTable, eq(emailsTable.batchId, emailBatchesTable.id))
    .where(where)
    // Newest first, with `id` making the order stable across pages.
    .orderBy(desc(emailsTable.createdAt), desc(emailsTable.id))
    .limit(limit)
    .offset(offset);

  return {
    rows: rows.map(withSafeError),
    total: Number(totals?.value ?? 0),
    page,
    limit,
  };
}

/** Returns one email's delivery detail, or null when it is not the user's. */
export async function getEmailById(
  userId: number,
  emailId: string,
): Promise<EmailDetail | null> {
  const [row] = await db
    .select({ ...listColumns, providerMessageId: emailsTable.providerMessageId })
    .from(emailsTable)
    .innerJoin(emailBatchesTable, eq(emailsTable.batchId, emailBatchesTable.id))
    .where(
      and(
        eq(emailsTable.id, emailId),
        eq(emailBatchesTable.userId, userId),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  return withSafeError(row);
}
