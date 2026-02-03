import { q } from "./db.js";
import { hash } from "./auth.js";
import fs from "fs";

const run = async () => {
  const schema = fs.readFileSync(new URL("./db/schema.sql", import.meta.url), "utf8");
  await q(schema);

  await q("INSERT INTO divisions(name) VALUES ($1),($2)", ["Kozmetike","Ushqimore"]);
  await q("INSERT INTO buyers(code,name) VALUES ($1,$2),($3,$4)", ["0012","Super Viva","0007","Viva Fresh"]);
  await q("INSERT INTO buyer_sites(buyer_id,site_code,site_name) VALUES (1,'12','Super Viva Fushë Kosovë'), (1,'01','Super Viva Qendër')");
  await q("INSERT INTO articles(sku,name,sell_price) VALUES ($1,$2,$3),($4,$5,$6)", ["JAM001","Jamnica Orange",1.20,"MLK010","Milk 1L",0.89]);

  const adminPass = await hash("admin123");
  const leadPass  = await hash("lead123");
  const divPass   = await hash("div123");
  const dirPass   = await hash("dir123");
  const agPass    = await hash("agent123");

  await q("INSERT INTO users(first_name,last_name,email,password_hash,role,division_id,pda_number) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["Admin","User","admin@local",adminPass,"admin",1,null]);
  await q("INSERT INTO users(first_name,last_name,email,password_hash,role,division_id,pda_number) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["Tea","Lead","lead@local",leadPass,"team_lead",1,null]);
  await q("INSERT INTO users(first_name,last_name,email,password_hash,role,division_id,pda_number) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["Diva","Manager","div@local",divPass,"division_manager",1,null]);
  await q("INSERT INTO users(first_name,last_name,email,password_hash,role,division_id,pda_number) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["Sale","Director","dir@local",dirPass,"sales_director",null,null]);
  await q("INSERT INTO users(first_name,last_name,email,password_hash,role,division_id,pda_number) VALUES ($1,$2,$3,$4,$5,$6,$7)", ["Agim","Agent","agent@local",agPass,"agent",1,"PDA-123"]);

  console.log("Seeded.");
  process.exit(0);
};
run().catch(e=>{ console.error(e); process.exit(1); });
