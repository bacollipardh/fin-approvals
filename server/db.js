import pg from "pg";
import dotenv from "dotenv";
import { readEnvOrFile } from "./util/secrets.js";

dotenv.config();

const connectionString = process.env.DATABASE_URL || "";

const config = connectionString
  ? { connectionString }
  : {
      host: process.env.PGHOST || "localhost",
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || "postgres",
      database: process.env.PGDATABASE || "lejimet",
      password: readEnvOrFile("PGPASSWORD"),
    };

export const pool = new pg.Pool({
  ...config,
  max: Number(process.env.PGPOOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 10000),
});

export const q = (text, params) => pool.query(text, params);

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const qtx = (text, params) => client.query(text, params);
    const out = await fn(qtx);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
