import "dotenv/config";
import redisConnection from "../email.redis.js";
import logger, { serializeError } from "../../lib/logger.js";

async function main() {
    try {
        const pong = await redisConnection.ping();
        logger.info("Redis is connected", { response: pong });
    } catch (err) {
        logger.error("Redis test failed", { error: serializeError(err) });
    }finally{
        await redisConnection.quit();
    }
}

main();

