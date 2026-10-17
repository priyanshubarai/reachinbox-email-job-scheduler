import "dotenv/config";
import { Pool } from "@neondatabase/serverless";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const res = await pool.query(
  "select column_name from information_schema.columns where table_name = 'users' order by ordinal_position",
);
console.log("users columns:", res.rows.map((r) => r.column_name).join(", "));
const t = await pool.query("select count(*)::int as n from users");
console.log("users row count:", t.rows[0].n);
await pool.end();
