
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import  db  from "../db/index.js";
import { emailsTable } from "../db/schema.js";
import redisConnection from "../utils/email.redis.js";
import { EMAIL_QUEUE_NAME, type SendEmailJob } from "../queue/email.queue.js";
import { mailer } from "../utils/mailer.js";
import nodemailer from "nodemailer";

const concurrency = Number(
  process.env.WORKER_CONCURRENCY ?? 2,
);

if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("WORKER_CONCURRENCY must be a positive integer");
}

export const emailWorker = new Worker<SendEmailJob>(
  EMAIL_QUEUE_NAME,
  async (job) => {
    const { emailId } = job.data;

    const [email] = await db
      .select()
      .from(emailsTable)
      .where(eq(emailsTable.id, emailId))
      .limit(1);

    if (!email) {
      throw new Error(`Email ${emailId} not found`);
    }

    if (email.status === "sent") {
      return { skipped: true, reason: "already-sent" };
    }

    if (
      email.status === "sending" ||
      email.status === "unknown"
    ) {
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
      .where(eq(emailsTable.id, emailId))
      .returning({ id: emailsTable.id });

    if (claimed.length === 0) {
      return { skipped: true, reason: "claim-lost" };
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

      console.log("Email sent:", emailId);
      console.log("Ethereal preview:", previewUrl);

      return {
        emailId,
        messageId: info.messageId,
        previewUrl,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      // SMTP may have accepted a message before a connection
      await db
        .update(emailsTable)
        .set({
          status: "unknown",
          lastError: message.slice(0, 4000),
          updatedAt: new Date(),
        })
        .catch((dbError) => {
          console.error("Failed to record SMTP outcome:", dbError);
        });

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency,
  },
);

emailWorker.on("failed", (job, error) => {
  console.error(
    `Email job ${job?.id ?? "unknown"} failed:`,
    error.message,
  );
});

emailWorker.on("error", (error) => {
  console.error("BullMQ worker error:", error);
});
