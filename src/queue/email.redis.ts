import "dotenv/config";
import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    throw new Error("REDIS_URL is not defined");
}

const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: () => {
        return 1000;
    },
});

redisConnection.on("error", (error :any) => {
    console.error("Redis connection error:", error);
});

redisConnection.on("connect", () => {
    console.log("Redis connected successfully");
});

export default redisConnection;
