import { and, count, eq, gte, sql } from "drizzle-orm";
import db from "../db/index.js";
import {
  emailBatchesTable,
  emailsTable,
  sendersTable,
} from "../db/schema.js";
import {
  EMAIL_STATUSES,
  type EmailStatus,
} from "../validators/common.validator.js";

export interface DashboardStats {
  generatedAt: string;
  totals: {
    batches: number;
    emails: number;
  };
  byStatus: Record<EmailStatus, number>;
  sentLast24Hours: number;
  scheduled: number;
  failed: number;
  perSender: Array<{
    senderId: string | null;
    fromEmail: string | null;
    fromName: string | null;
    emails: number;
    sent: number;
  }>;
  /**
   * Data source for this block. `database` means these are email delivery
   * states from PostgreSQL. BullMQ queue state is a different concept and is
   * intentionally not mixed in here.
   */
  source: "database";
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function emptyByStatus(): Record<EmailStatus, number> {
  return EMAIL_STATUSES.reduce(
    (acc, status) => {
      acc[status] = 0;
      return acc;
    },
    {} as Record<EmailStatus, number>,
  );
}

/**
 * Aggregated delivery + batch statistics for one user. Every number comes from
 * a SQL aggregate; no email rows are loaded into application memory.
 */
export async function getDashboardStats(
  userId: number,
): Promise<DashboardStats> {
  const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);

  const [batchTotals, emailTotals, statusRows, sentLast24Hours, perSender] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(emailBatchesTable)
        .where(eq(emailBatchesTable.userId, userId)),
      db
        .select({ value: count() })
        .from(emailsTable)
        .innerJoin(
          emailBatchesTable,
          eq(emailsTable.batchId, emailBatchesTable.id),
        )
        .where(eq(emailBatchesTable.userId, userId)),
      db
        .select({ status: emailsTable.status, value: count() })
        .from(emailsTable)
        .innerJoin(
          emailBatchesTable,
          eq(emailsTable.batchId, emailBatchesTable.id),
        )
        .where(eq(emailBatchesTable.userId, userId))
        .groupBy(emailsTable.status),
      db
        .select({ value: count() })
        .from(emailsTable)
        .innerJoin(
          emailBatchesTable,
          eq(emailsTable.batchId, emailBatchesTable.id),
        )
        .where(
          and(
            eq(emailBatchesTable.userId, userId),
            eq(emailsTable.status, "sent"),
            gte(emailsTable.sentAt, since),
          ),
        ),
      db
        .select({
          senderId: emailsTable.senderId,
          fromEmail: sendersTable.fromEmail,
          fromName: sendersTable.fromName,
          emails: count(),
          sent: sql<number>`count(*) filter (where ${emailsTable.status} = 'sent')`.mapWith(
            Number,
          ),
        })
        .from(emailsTable)
        .innerJoin(
          emailBatchesTable,
          eq(emailsTable.batchId, emailBatchesTable.id),
        )
        .leftJoin(sendersTable, eq(emailsTable.senderId, sendersTable.id))
        .where(eq(emailBatchesTable.userId, userId))
        .groupBy(emailsTable.senderId, sendersTable.fromEmail, sendersTable.fromName)
        .orderBy(emailsTable.senderId),
    ]);

  const byStatus = emptyByStatus();

  for (const row of statusRows) {
    if ((EMAIL_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as EmailStatus] = Number(row.value);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      batches: Number(batchTotals[0]?.value ?? 0),
      emails: Number(emailTotals[0]?.value ?? 0),
    },
    byStatus,
    sentLast24Hours: Number(sentLast24Hours[0]?.value ?? 0),
    scheduled: byStatus.scheduled,
    failed: byStatus.failed,
    perSender: perSender.map((row) => ({
      senderId: row.senderId,
      fromEmail: row.fromEmail,
      fromName: row.fromName,
      emails: Number(row.emails),
      sent: Number(row.sent),
    })),
    source: "database",
  };
}
