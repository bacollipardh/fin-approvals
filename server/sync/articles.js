import { q } from "../db.js";

function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v.replace(/\/$/, "");
}

export async function syncArticlesFromMssqlApi() {
  const base = mustEnv("MSSQL_API_BASE_URL");

  const url = `${base}/articles?limit=100000&offset=0`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`MSSQL API ${r.status}: ${await r.text()}`);

  const list = await r.json();
  const rows = Array.isArray(list) ? list : [];

  let upserted = 0;

  await q("BEGIN");
  try {
    for (const a of rows) {
      const sku = String(a.sku || "").trim();
      const name = String(a.name || "").trim();
      if (!sku || !name) continue;

      const sell_price = Number(a.sell_price ?? 0) || 0;
      const division_id = Number(a.division_id ?? 1) || 1;

      const special_rabat = Number(a.special_rabat ?? 0) || 0;
      const special_rabat_from = a.special_rabat_from ? new Date(a.special_rabat_from) : null;
      const special_rabat_to = a.special_rabat_to ? new Date(a.special_rabat_to) : null;

      await q(
        `INSERT INTO articles(sku,name,sell_price,division_id,special_rabat,special_rabat_from,special_rabat_to)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (sku) DO UPDATE SET
           name=EXCLUDED.name,
           sell_price=EXCLUDED.sell_price,
           division_id=EXCLUDED.division_id,
           special_rabat=EXCLUDED.special_rabat,
           special_rabat_from=EXCLUDED.special_rabat_from,
           special_rabat_to=EXCLUDED.special_rabat_to`,
        [sku, name, sell_price, division_id, special_rabat, special_rabat_from, special_rabat_to]
      );

      upserted++;
    }

    await q("COMMIT");
  } catch (e) {
    await q("ROLLBACK");
    throw e;
  }

  return { ok: true, total: rows.length, upserted };
}
