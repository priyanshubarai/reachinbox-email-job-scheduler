import "dotenv/config";
import redisConnection from "./email.redis.js";

async function main() {
    try {
        const pong = await redisConnection.ping();
        console.log("Redis is connected ",pong);
    } catch (err) {
        console.log("Redis test failed :" ,err);
    }finally{
        await redisConnection.quit();
    }
}

main();

