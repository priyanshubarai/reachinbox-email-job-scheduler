/**
 * Real-worker entry point for the restart test.
 *
 * This is a genuine worker process: it imports `src/workers/email.worker.ts`,
 * which constructs the BullMQ Worker as a side effect. The parent test spawns
 * it, waits for it to defer a job, shuts it down, and spawns a second copy to
 * prove the deferred job survives the restart.
 *
 * Env (REDIS_URL -> DB 15, SENDER_MIN_INTERVAL_MS=0, dead SMTP) is inherited
 * from the parent, which already loaded tests/setup-env.ts.
 */

import "./setup-env.js";
import { sentMails } from "./helpers/mock-mailer.js";

const { emailWorker } = await import("../src/workers/email.worker.js");
const { closeQueue } = await import("./helpers/queue.js");

async function shutdown(code: number): Promise<void> {
  try {
    await emailWorker.close();
    await closeQueue();
  } finally {
    // Report what the mocked mailer did on the way out so the parent can
    // assert on it without a second channel.
    process.stdout.write(`worker-exit:${code}:sent=${sentMails().length}\n`);
    process.exit(code);
  }
}

process.on("message", (msg: unknown) => {
  if (msg === "shutdown") {
    void shutdown(0);
  }
});

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

emailWorker.on("ready", () => {
  process.stdout.write("worker-ready\n");
});

process.stdout.write("worker-started\n");
