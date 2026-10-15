import "dotenv/config";
import { runOutboxDispatcher } from "./queue/outbox-dispatcher.js";
import { emailWorker } from "./workers/email.worker.js";
import { emailQueue } from "./queue/email.queue.js";
import redisConnection  from "./utils/email.redis.js";

const controller = new AbortController();

async function shutdown() {
  controller.abort();
  await emailWorker.close();
  await emailQueue.close();
  await redisConnection.quit();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

runOutboxDispatcher(controller.signal).catch((error) => {
  console.error("Dispatcher stopped unexpectedly:", error);
  process.exitCode = 1;
});