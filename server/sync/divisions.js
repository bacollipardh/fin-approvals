import { q } from "../db.js";

function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v.replace(/\/$/, "");
}

export async function syncDivisionsFromMssqlApi() {
  const base = mustEnv("MSSQL_API_BASE_URL");

  const url = `${base}/divisions?limit=100000&offset=0`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`MSSQL API ${r.status}: ${await r.text()}`);

  const rows = await r.json();
  const list = Array.isArray(rows) ? rows : [];

  let upserted = 0;

  await q("BEGIN");
  try {
    for (const d of list) {
      const id = Number(d.id);
      const name = String(d.name || "").trim();
      if (!id || !name) continue;

      await q(
        `INSERT INTO divisions(id, name)
         VALUES($1,$2)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
        [id, name]
      );
      upserted++;
    }

    await q("COMMIT");
  } catch (e) {
    await q("ROLLBACK");
    throw e;
  }

  return { ok: true, total: list.length, upserted };
}
