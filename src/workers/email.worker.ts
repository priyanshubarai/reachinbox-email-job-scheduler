
import { DelayedError, Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import db from "../db/index.js";
import {
  emailBatchesTable,
  emailsTable,
  sendersTable,
  usersTable,
} from "../db/schema.js";
import redisConnection from "../utils/email.redis.js";
import { EMAIL_QUEUE_NAME, type SendEmailJob } from "../queue/email.queue.js";
import { mailer } from "../utils/mailer.js";
import nodemailer from "nodemailer";
import logger, { serializeError } from "../lib/logger.js";
import {
  reserveSendCapacity,
  type RateLimitResult,
} from "../utils/rate-limiter.js";
import { notifySlack } from "../utils/slack.js";

const concurrency = Number(
  process.env.WORKER_CONCURRENCY ?? 2,
);

if (!Number.isInteger(concurrency) || concurrency < 1) {
  logger.error(
    "Configuration error: WORKER_CONCURRENCY must be a positive integer",
    { value: process.env.WORKER_CONCURRENCY },
  );
  throw new Error("WORKER_CONCURRENCY must be a positive integer");
}

/**
 * Minimum spacing between two sends by the same sender. 0 disables the check.
 * Configured globally; there is no per-sender column for this yet.
 */
const SENDER_MIN_INTERVAL_MS = (() => {
  const raw = process.env.SENDER_MIN_INTERVAL_MS;
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
})();

/** Minimum gap between Slack rate-limit alerts for the same sender. */
const SLACK_NOTIFY_THROTTLE_SECONDS = 300;

/**
 * SMTP error codes that will not succeed on retry (bad credentials, rejected
 * envelope, malformed message). Everything else is treated as potentially
 * transient (network, DNS, timeout) and therefore retryable.
 */
const NON_RETRYABLE_SMTP_CODES = new Set([
  "EAUTH",
  "EENVELOPE",
  "EMESSAGE",
  "EACCOUNT",
]);

function isRetryableSmtpError(error: unknown): boolean {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;

  if (typeof code === "string") {
    return !NON_RETRYABLE_SMTP_CODES.has(code);
  }

  return true;
}

/** Ethereal preview URLs are only useful in non-production environments. */
const logPreviewUrls =
  process.env.NODE_ENV !== "production" ||
  process.env.LOG_EMAIL_PREVIEW_URLS === "true";

interface RateLimitContext {
  userId: number;
  senderId: string | null;
  senderHourlyLimit: number | null;
  tenantHourlyLimit: number;
  slackWebhookUrl: string | null;
}

/**
 * Resolves the sender + tenant quotas for an email. Returns null when the
 * context cannot be resolved; the caller then proceeds without rate limiting
 * (quota enforcement is best-effort and must never block delivery on a lookup
 * problem).
 */
async function loadRateLimitContext(
  email: typeof emailsTable.$inferSelect,
): Promise<RateLimitContext | null> {
  try {
    const [batch] = await db
      .select({
        userId: emailBatchesTable.userId,
        senderId: emailBatchesTable.senderId,
      })
      .from(emailBatchesTable)
      .where(eq(emailBatchesTable.id, email.batchId))
      .limit(1);

    if (!batch) {
      return null;
    }

    const [user] = await db
      .select({ tenantHourlyLimit: usersTable.tenantHourlyLimit })
      .from(usersTable)
      .where(eq(usersTable.id, batch.userId))
      .limit(1);

    if (!user) {
      return null;
    }

    // Sender may be recorded on the email or only on the batch.
    const senderId = email.senderId ?? batch.senderId ?? null;

    let senderHourlyLimit: number | null = null;
    let slackWebhookUrl: string | null = null;

    if (senderId) {
      const [sender] = await db
        .select({
          hourlyLimit: sendersTable.hourlyLimit,
          slackWebhookUrl: sendersTable.slackWebhookUrl,
        })
        .from(sendersTable)
        .where(eq(sendersTable.id, senderId))
        .limit(1);

      if (sender) {
        senderHourlyLimit = sender.hourlyLimit;
        slackWebhookUrl = sender.slackWebhookUrl ?? null;
      }
    }

    return {
      userId: batch.userId,
      senderId,
      senderHourlyLimit,
      tenantHourlyLimit: user.tenantHourlyLimit,
      slackWebhookUrl,
    };
  } catch (error) {
    logger.warn("Failed to resolve rate-limit context", {
      emailId: email.id,
      error: serializeError(error),
    });
    return null;
  }
}

async function enforceRateLimit(
  job: { id?: string; moveToDelayed: (ts: number, token?: string) => Promise<void> },
  token: string | undefined,
  email: typeof emailsTable.$inferSelect,
): Promise<void> {
  const context = await loadRateLimitContext(email);

  if (!context) {
    logger.warn("Rate limiting skipped: limits could not be resolved", {
      queue: EMAIL_QUEUE_NAME,
      jobId: job.id,
      emailId: email.id,
    });
    return;
  }

  const reservation: RateLimitResult = await reserveSendCapacity({
    emailId: email.id,
    userId: context.userId,
    senderId: context.senderId,
    senderHourlyLimit: context.senderHourlyLimit,
    tenantHourlyLimit: context.tenantHourlyLimit,
    minIntervalMs: SENDER_MIN_INTERVAL_MS,
  });

  if (reservation.allowed) {
    return;
  }

  // Delay relative to the two clocks involved so worker/Redis skew cancels out.
  const delayMs = Math.max(1, reservation.retryAt - reservation.serverNow);

  logger.warn("Email send rate-limited; delaying job", {
    queue: EMAIL_QUEUE_NAME,
    jobId: job.id,
    emailId: email.id,
    senderId: context.senderId,
    userId: context.userId,
    reason: reservation.reason,
    delayMs,
    retryAt: reservation.retryAt,
  });

  if (context.slackWebhookUrl) {
    // Throttle per sender so a backlog of denied jobs cannot flood the webhook.
    const throttleKey = `rl:{u:${context.userId}}:slack:${context.senderId ?? "-"}:notified`;
    const shouldNotify = await redisConnection.set(
      throttleKey,
      "1",
      "EX",
      SLACK_NOTIFY_THROTTLE_SECONDS,
      "NX",
    );

    if (shouldNotify === "OK") {
      await notifySlack(
        context.slackWebhookUrl,
        `:hourglass_flowing_sand: Rate limit reached for sender ` +
          `${context.senderId ?? "(unassigned)"} (reason: ${reservation.reason}). ` +
          `Holding email ${email.id}; retrying in ~${Math.ceil(delayMs / 1000)}s.`,
      );
    }
  }

  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

export const emailWorker = new Worker<SendEmailJob>(
  EMAIL_QUEUE_NAME,
  async (job, token) => {
    const startedAt = Date.now();
    const { emailId } = job.data;

    logger.info("Email job started", {
      queue: EMAIL_QUEUE_NAME,
      jobId: job.id,
      emailId,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
    });

    const [email] = await db
      .select()
      .from(emailsTable)
      .where(eq(emailsTable.id, emailId))
      .limit(1);

    if (!email) {
      throw new Error(`Email ${emailId} not found`);
    }

    if (email.status === "sent") {
      logger.debug("Email job skipped: already sent", {
        queue: EMAIL_QUEUE_NAME,
        jobId: job.id,
        emailId,
      });
      return { skipped: true, reason: "already-sent" };
    }

    if (
      email.status === "sending" ||
      email.status === "unknown"
    ) {
      logger.debug("Email job skipped: needs reconciliation", {
        queue: EMAIL_QUEUE_NAME,
        jobId: job.id,
        emailId,
        emailStatus: email.status,
      });
      return { skipped: true, reason: "needs-reconciliation" };
    }

    // Reserve quota before claiming so a denied send never leaves the email in
    // a "sending" state. May delay the job and throw DelayedError.
    await enforceRateLimit(job, token, email);

    // Atomically claim the email.
    const claimed = await db
      .update(emailsTable)
      .set({
        status: "sending",
        updatedAt: new Date(),
        lastError: null,
      })
      .where(
        and(
          eq(emailsTable.id, emailId),
          eq(emailsTable.status, "scheduled")
        )
      )
      .returning({ id: emailsTable.id });

    if (claimed.length === 0) {
      logger.debug("Email job skipped: claim lost or not scheduled", {
        queue: EMAIL_QUEUE_NAME,
        jobId: job.id,
        emailId,
      });
      return { skipped: true, reason: "claim-lost-or-not-scheduled" };
    }

    try {
      const info = await mailer.sendMail({
        from: `"ReachInbox Test" <${process.env.ETHEREAL_USER}>`,
        to: email.recipient,
        subject: email.subject,
        text: email.body,
      });

      const previewUrl = nodemailer.getTestMessageUrl(info);

      await db
        .update(emailsTable)
        .set({
          status: "sent",
          sentAt: new Date(),
          providerMessageId: info.messageId,
          updatedAt: new Date(),
          lastError: null,
        })
        .where(eq(emailsTable.id, emailId));

      logger.info("Email sent", {
        queue: EMAIL_QUEUE_NAME,
        jobId: job.id,
        emailId,
        senderId: email.senderId,
        providerMessageId: info.messageId,
        durationMs: Date.now() - startedAt,
        attemptsMade: job.attemptsMade,
        ...(logPreviewUrls && previewUrl ? { previewUrl } : {}),
      });

      return {
        emailId,
        messageId: info.messageId,
        previewUrl,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      logger.warn("Email send attempt failed", {
        queue: EMAIL_QUEUE_NAME,
        jobId: job.id,
        emailId,
        senderId: email.senderId,
        retryable: isRetryableSmtpError(error),
        durationMs: Date.now() - startedAt,
        error: serializeError(error),
      });

      // SMTP may have accepted a message before a connection
      await db
        .update(emailsTable)
        .set({
          status: "unknown",
          lastError: message.slice(0, 4000),
          updatedAt: new Date(),
        })
        .where(eq(emailsTable.id, emailId))
        .catch((dbError) => {
          logger.error("Failed to record SMTP outcome", {
            queue: EMAIL_QUEUE_NAME,
            jobId: job.id,
            emailId,
            error: serializeError(dbError),
          });
        });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency,
  },
);

emailWorker.on("ready", () => {
  logger.info("Email worker ready", {
    queue: EMAIL_QUEUE_NAME,
    concurrency,
    senderMinIntervalMs: SENDER_MIN_INTERVAL_MS,
  });
});

emailWorker.on("failed", (job, error) => {
  const maxAttempts = job?.opts.attempts ?? 1;
  const attemptsMade = job?.attemptsMade ?? 0;
  const willRetry = attemptsMade < maxAttempts;

  const context = {
    queue: EMAIL_QUEUE_NAME,
    jobId: job?.id ?? "unknown",
    emailId: job?.data?.emailId,
    attemptsMade,
    maxAttempts,
    errorMessage: error.message,
  };

  if (willRetry) {
    logger.warn("Email job attempt failed; will retry", context);
  } else {
    logger.error("Email job failed and exhausted retries", context);
  }
});

emailWorker.on("error", (error) => {
  logger.error("BullMQ worker error", {
    queue: EMAIL_QUEUE_NAME,
    error: serializeError(error),
  });
});
