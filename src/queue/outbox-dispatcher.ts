
import { and, asc, eq, lte } from "drizzle-orm";
import db from "../db/index.js";
import {
        emailsTable,
        outboxEventsTable,
} from "../db/schema.js";
import { emailQueue } from "./email.queue.js";
import logger, { serializeError } from "../lib/logger.js";

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1000;

export async function dispatchPendingOutboxOnce(): Promise<number> {
        const events = await db
                .select()
                .from(outboxEventsTable)
                .where(and(
                        eq(outboxEventsTable.status, "pending"),
                        eq(outboxEventsTable.eventType, "email.schedule"),
                        lte(outboxEventsTable.availableAt, new Date()),
                ))
                .orderBy(asc(outboxEventsTable.createdAt))
                .limit(BATCH_SIZE);

        if (events.length > 0) {
                logger.debug("Outbox dispatch cycle", { examined: events.length });
        }

        let published = 0;

        for (const event of events) {
                if (event.status !== "pending") continue;
                if (event.eventType !== "email.schedule") continue;

                try {
                        const [email] = await db
                                .select()
                                .from(emailsTable)
                                .where(eq(emailsTable.id, event.aggregateId))
                                .limit(1);

                        if (!email) {
                                logger.warn("Outbox event references missing email", {
                                        outboxEventId: event.id,
                                        eventType: event.eventType,
                                        aggregateId: event.aggregateId,
                                });
                                continue;
                        }

                        if (email.status !== "scheduled") {
                                await db
                                        .update(outboxEventsTable)
                                        .set({
                                                status: "processed",
                                                processedAt: new Date(),
                                        })
                                        .where(eq(outboxEventsTable.id, event.id));

                                logger.debug("Outbox event skipped: email not scheduled", {
                                        outboxEventId: event.id,
                                        emailId: email.id,
                                        emailStatus: email.status,
                                });

                                continue;
                        }

                        const delay = Math.max(
                                0,
                                email.scheduledAt.getTime() - Date.now(),
                        );

                        await emailQueue.add(
                                "send-email",
                                { emailId: email.id },
                                {
                                        jobId: email.id,
                                        delay,
                                },
                        );

                        // Mark processed only after BullMQ accepts the job.
                        await db
                                .update(outboxEventsTable)
                                .set({
                                        status: "processed",
                                        processedAt: new Date(),
                                        attempts: event.attempts + 1,
                                        lastError: null,
                                })
                                .where(eq(outboxEventsTable.id, event.id));

                        published++;

                        logger.debug("Outbox event dispatched to queue", {
                                outboxEventId: event.id,
                                eventType: event.eventType,
                                emailId: email.id,
                                delayMs: delay,
                        });
                } catch (error) {
                        const message =
                                error instanceof Error ? error.message : String(error);

                        logger.error("Outbox event dispatch failed", {
                                outboxEventId: event.id,
                                eventType: event.eventType,
                                aggregateId: event.aggregateId,
                                attempt: event.attempts + 1,
                                error: serializeError(error),
                        });

                        await db
                                .update(outboxEventsTable)
                                .set({
                                        attempts: event.attempts + 1,
                                        lastError: message.slice(0, 4000),
                                        availableAt: new Date(Date.now() + 5000),
                                })
                                .where(eq(outboxEventsTable.id, event.id))
                                .catch((dbError) => {
                                        logger.error("Could not update outbox event after failure", {
                                                outboxEventId: event.id,
                                                error: serializeError(dbError),
                                        });
                                });
                }
        }

        if (published > 0) {
                logger.info("Outbox dispatch cycle complete", { published });
        }

        return published;
}

const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runOutboxDispatcher(
        signal: AbortSignal,
): Promise<void> {
        logger.info("Outbox dispatcher started", {
                pollIntervalMs: POLL_INTERVAL_MS,
                batchSize: BATCH_SIZE,
        });

        while (!signal.aborted) {
                try {
                        await dispatchPendingOutboxOnce();
                } catch (error) {
                        logger.error("Outbox polling cycle failed", {
                                error: serializeError(error),
                        });
                }

                if (!signal.aborted) {
                        await sleep(POLL_INTERVAL_MS);
                }
        }

        logger.info("Outbox dispatcher stopped");
}
