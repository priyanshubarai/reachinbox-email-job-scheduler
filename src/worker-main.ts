import "dotenv/config";
import { runOutboxDispatcher } from "./queue/outbox-dispatcher.js";
import { emailWorker } from "./workers/email.worker.js";
import { emailQueue } from "./queue/email.queue.js";
import redisConnection from "./utils/email.redis.js";
import logger, {
  installProcessErrorHandlers,
  serializeError,
} from "./lib/logger.js";

installProcessErrorHandlers();

const controller = new AbortController();

async function shutdown(signal: string) {
  logger.info("Worker shutting down", { signal });
  controller.abort();
  await emailWorker.close();
  await emailQueue.close();
  await redisConnection.quit();
  logger.info("Worker shutdown complete");
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("Worker process starting");

runOutboxDispatcher(controller.signal).catch((error) => {
  logger.error("Dispatcher stopped unexpectedly", {
    error: serializeError(error),
  });
  process.exitCode = 1;
});
