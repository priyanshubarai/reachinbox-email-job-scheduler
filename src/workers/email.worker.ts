
import { Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import db from "../db/index.js";
import { emailsTable } from "../db/schema.js";
import redisConnection from "../utils/email.redis.js";
import { EMAIL_QUEUE_NAME, type SendEmailJob } from "../queue/email.queue.js";
import { mailer } from "../utils/mailer.js";
import nodemailer from "nodemailer";
import logger, { serializeError } from "../lib/logger.js";

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

export const emailWorker = new Worker<SendEmailJob>(
  EMAIL_QUEUE_NAME,
  async (job) => {
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
