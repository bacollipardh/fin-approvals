import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { pool } from "./db.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`
  );
}

async function isApplied(name) {
  const r = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
  return !!r.rowCount;
}

async function markApplied(name) {
  await pool.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT(name) DO NOTHING", [name]);
}

async function applyOne(name, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT(name) DO NOTHING", [name]);
    await client.query("COMMIT");
    console.log(`[MIGRATE] applied: ${name}`);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(`[MIGRATE] failed: ${name}`);
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  await ensureMigrationsTable();

  if (!fs.existsSync(MIG_DIR)) {
    console.log("[MIGRATE] no migrations dir");
    return;
  }

  const files = fs.readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const f of files) {
    if (await isApplied(f)) continue;
    const sql = fs.readFileSync(path.join(MIG_DIR, f), "utf8");
    await applyOne(f, sql);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[MIGRATE] error:", e?.message || e);
    process.exit(1);
  });
