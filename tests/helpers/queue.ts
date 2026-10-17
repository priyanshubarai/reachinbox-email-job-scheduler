import { emailQueue, EMAIL_QUEUE_NAME } from "../../src/queue/email.queue.js";

export { emailQueue, EMAIL_QUEUE_NAME };

/**
 * The worker test queue lives in Redis DB 15 (see tests/setup-env.ts), so it
 * can only ever contain jobs this suite created. If anything is already in it
 * we refuse to run rather than risk interference from a previous run.
 */
export async function assertQueueIsEmpty(): Promise<void> {
  const counts = await emailQueue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
    "completed",
    "paused",
  );
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  if (total > 0) {
    throw new Error(
      `Test queue "${EMAIL_QUEUE_NAME}" is not empty in the test Redis ` +
        `database (counts=${JSON.stringify(counts)}). Refusing to run so a ` +
        `leftover job cannot be confused with this test's job.`,
    );
  }
}

/** Enqueues a send job keyed by emailId, exactly like the outbox dispatcher. */
export async function enqueueSendJob(
  emailId: string,
  opts: { delay?: number } = {},
): Promise<void> {
  await emailQueue.add(
    "send-email",
    { emailId },
    { jobId: emailId, delay: opts.delay ?? 0 },
  );
}

/** Number of jobs carrying this jobId (0, 1, or >1 if a duplicate exists). */
export async function countJobsForEmail(emailId: string): Promise<number> {
  const jobs = await emailQueue.getJobs();
  return jobs.filter((job) => job.id === emailId).length;
}

export async function closeQueue(): Promise<void> {
  await emailQueue.close();
}
