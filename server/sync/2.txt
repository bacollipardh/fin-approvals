import { pool } from "../db.js";

function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.json();
}

export async function syncArticlesFromMssqlApi() {
  const base = reqEnv("MSSQL_API_BASE_URL").replace(/\/+$/, "");
  const pageSize = Number(process.env.SYNC_ARTICLES_PAGE_SIZE || "1000");
  const requireDivision = (process.env.SYNC_REQUIRE_DIVISION || "true") === "true";

  const cnt = await fetchJson(`${base}/articles/count`);
  const total = Number(cnt.total || 0);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (let offset = 0; offset < total; offset += pageSize) {
    const rows = await fetchJson(`${base}/articles?limit=${pageSize}&offset=${offset}`);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const a of rows) {
        const sku = String(a.sku || "").trim();
        if (!sku) { skipped++; continue; }

        const name = String(a.name || "").trim();
        const sell_price = Number(a.sell_price || 0);

        let division_id = a.division_id;
        if (division_id === null || division_id === undefined || division_id === "") division_id = 1;
        division_id = Number(division_id);

        if (requireDivision) {
          const chk = await client.query("SELECT 1 FROM divisions WHERE id=$1", [division_id]);
          if (chk.rowCount === 0) { skipped++; continue; }
        }

        const q = `
          INSERT INTO articles (sku, name, sell_price, division_id)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (sku) DO UPDATE
          SET name = EXCLUDED.name,
              sell_price = EXCLUDED.sell_price,
              division_id = EXCLUDED.division_id
          RETURNING (xmax = 0) AS inserted;
        `;

        const res = await client.query(q, [sku, name, sell_price, division_id]);
        if (res.rows[0]?.inserted) inserted++;
        else updated++;
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  return { ok: true, total, inserted, updated, skipped };
}
