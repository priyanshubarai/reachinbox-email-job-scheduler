import "dotenv/config";
import { Redis } from "ioredis";
import logger, { serializeError } from "../lib/logger.js";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    logger.error("Configuration error: REDIS_URL is not defined");
    throw new Error("REDIS_URL is not defined");
}

const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: () => {
        return 1000;
    },
});

redisConnection.on("connect", () => {
    logger.info("Redis socket connected");
});

redisConnection.on("ready", () => {
    logger.info("Redis connection ready");
});

redisConnection.on("reconnecting", (delay: number) => {
    logger.warn("Redis reconnecting", { delayMs: delay });
});

redisConnection.on("error", (error: unknown) => {
    logger.error("Redis connection error", { error: serializeError(error) });
});

redisConnection.on("end", () => {
    logger.warn("Redis connection closed");
});

export default redisConnection;
