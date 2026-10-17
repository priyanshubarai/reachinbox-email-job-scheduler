import "dotenv/config";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle({ client: pool });

/**
 * Closes the underlying connection pool. Used by tests and the shutdown path so
 * the process can exit without dangling sockets.
 */
export async function closeDb(): Promise<void> {
  await pool.end();
}

export default db;
