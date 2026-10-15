
import { asc, eq, lte } from "drizzle-orm";
import db from "../db/index.js";
import {
        emailsTable,
        outboxEventsTable,
} from "../db/schema.js";
import { emailQueue } from "./email.queue.js";

const BATCH_SIZE = 50;
const POLL_INTERVAL_MS = 1000;

export async function dispatchPendingOutboxOnce(): Promise<number> {
        const events = await db
                .select()
                .from(outboxEventsTable)
                .where(
                        lte(outboxEventsTable.availableAt, new Date()),
                )
                .orderBy(asc(outboxEventsTable.createdAt))
                .limit(BATCH_SIZE);

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
                                console.error(
                                        `Outbox event ${event.id} references missing email ${event.aggregateId}`,
                                );
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
                } catch (error) {
                        const message =
                                error instanceof Error ? error.message : String(error);

                        console.error(`Outbox dispatch failed for ${event.id}:`, message);

                        await db
                                .update(outboxEventsTable)
                                .set({
                                        attempts: event.attempts + 1,
                                        lastError: message.slice(0, 4000),
                                        availableAt: new Date(Date.now() + 5000),
                                })
                                .where(eq(outboxEventsTable.id, event.id))
                                .catch((dbError) => {
                                        console.error("Could not update outbox event:", dbError);
                                });
                }
        }

        return published;
}

const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runOutboxDispatcher(
        signal: AbortSignal,
): Promise<void> {
        console.log("Outbox dispatcher started");

        while (!signal.aborted) {
                try {
                        await dispatchPendingOutboxOnce();
                } catch (error) {
                        console.error("Outbox polling failed:", error);
                }

                if (!signal.aborted) {
                        await sleep(POLL_INTERVAL_MS);
                }
        }

        console.log("Outbox dispatcher stopped");
}
