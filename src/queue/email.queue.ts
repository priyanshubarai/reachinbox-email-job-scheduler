import { Queue } from "bullmq";
import redisConnection from "../utils/email.redis.js";

export const EMAIL_QUEUE_NAME = "email-sending";

export interface SendEmailJob {
    emailId: string;
}

export const emailQueue = new Queue<SendEmailJob>(EMAIL_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions:{
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: true,
    }
});