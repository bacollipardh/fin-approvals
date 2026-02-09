// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import fs from "fs";
import multer from "multer";
import crypto from "crypto";

import { q, withTx } from "./db.js";
import { readEnvOrFile } from "./util/secrets.js";
import { signJWT, compare, hash, requireAuth, requireRole } from "./auth.js";
import { requiredRoleForAmount } from "./approvalLogic.js";
import { normalizeNumbers } from "./normalize-mw.js";
import { syncArticlesFromMssqlApi } from "./sync/articles.js";
import { syncDivisionsFromMssqlApi } from "./sync/divisions.js";



dotenv.config();

/* ----------------------------- ENV NORMALIZER ----------------------------- */
process.env.LEJIMET_EMAIL = (process.env.LEJIMET_EMAIL || process.env.FINAL_APPROVAL_EMAIL || "").trim();
process.env.MAIL_FROM     = (process.env.SMTP_FROM || process.env.MAIL_FROM || process.env.SMTP_USER || "").trim();
process.env.SMTP_PASS    = readEnvOrFile("SMTP_PASS");

console.log("[ENV] LEJIMET_EMAIL =", process.env.LEJIMET_EMAIL || "(empty)");
console.log("[ENV] MAIL_FROM     =", process.env.MAIL_FROM || "(empty)");

const REFRESH_PEPPER = readEnvOrFile("REFRESH_PEPPER");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

/* --------------------------------- APP ----------------------------------- */
const app = express();

if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / curl / healthchecks
  if (!allowedOrigins.length) {
    return /^https?:\/\/localhost(?::\d+)?$/i.test(origin);
  }
  return allowedOrigins.includes(origin);
}

app.use(cors({
  origin: (origin, cb) => cb(isAllowedOrigin(origin) ? null : new Error("CORS"), isAllowedOrigin(origin)),
  credentials: true
}));
app.use(express.json());
app.use(normalizeNumbers); // auto numeric normalization (qty>=1, percent 0..100)
app.use(morgan("dev"));

/* ----------- API prefix compatibility: lejon /api/... dhe pa /api -------- */
const API_PREFIX = process.env.API_PREFIX || "/api";
app.use((req, _res, next) => {
  if (req.url === API_PREFIX) req.url = "/";
  else if (req.url.startsWith(API_PREFIX + "/")) req.url = req.url.slice(API_PREFIX.length);
  next();
});

/* -------------------------------- HELPERS -------------------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URL   = process.env.APP_URL || "http://localhost:5173";
const PUBLIC_API = (process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
const fmtMoney = (n) => Number(n || 0).toFixed(2);

async function regclassExists(name) {
  try {
    const r = await q("SELECT to_regclass($1) as t", [name]);
    return Boolean(r.rows?.[0]?.t);
  } catch {
    return false;
  }
}

function pgCode(e) {
  return e?.code || e?.errno || "";
}
const cleanId = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* ---------------------------- UPLOADS (IMAGES) --------------------------- */
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", index: false }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + "-" + Math.random().toString(36).slice(2) + ext;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per photo
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error("Invalid file type"), ok);
  },
});

/* -------------------- APPROVER EMAILS (helper) --------------------------- */
async function approverEmailsFor(reqRow) {
  if (reqRow.required_role === "team_lead") {
    const assigneeId = reqRow.assigned_to_user_id
      ?? (await resolveTeamLeadAssignee({ agentId: reqRow.agent_id, divisionId: reqRow.division_id })).assigneeId;

    if (!assigneeId) return [];
    const r = await q("SELECT email FROM users WHERE id=$1 AND email IS NOT NULL", [assigneeId]);
    return r.rows.map((x) => x.email).filter(Boolean);
  }
  if (reqRow.required_role === "division_manager") {
    const r = await q(
      "SELECT email FROM users WHERE role='division_manager' AND division_id=$1 AND email IS NOT NULL",
      [reqRow.division_id]
    );
    return r.rows.map((x) => x.email).filter(Boolean);
  }
  const r = await q("SELECT email FROM users WHERE role='sales_director' AND email IS NOT NULL");
  return r.rows.map((x) => x.email).filter(Boolean);
}

/* ------------------- LOAD FOR PDF / EMAIL (unchanged) -------------------- */

async function resolveTeamLeadAssignee({ agentId, divisionId, qfn = q }) {
  // 1) agent.team_leader_id
  const a = await qfn("SELECT team_leader_id FROM users WHERE id=$1", [agentId]);
  const agentTl = a.rows?.[0]?.team_leader_id || null;

  const isValidTl = async (id) => {
    if (!id) return false;
    const r = await qfn(
      "SELECT 1 FROM users WHERE id=$1 AND role='team_lead' AND division_id=$2",
      [id, divisionId]
    );
    return !!r.rowCount;
  };

  if (agentTl && (await isValidTl(agentTl))) {
    return { assigneeId: agentTl, reason: "agent.team_leader_id" };
  }

  // 2) division.default_team_leader_id
  const d = await qfn("SELECT default_team_leader_id FROM divisions WHERE id=$1", [divisionId]);
  const divTl = d.rows?.[0]?.default_team_leader_id || null;
  if (divTl && (await isValidTl(divTl))) {
    return { assigneeId: divTl, reason: "division.default_team_leader_id" };
  }

  // 3) deterministic single TL in division
  const tl = await qfn(
    "SELECT id FROM users WHERE role='team_lead' AND division_id=$1 ORDER BY id ASC LIMIT 1",
    [divisionId]
  );
  if (tl.rowCount) return { assigneeId: tl.rows[0].id, reason: "fallback.first_team_lead_in_division" };

  // 4) deterministic division manager
  const dm = await qfn(
    "SELECT id FROM users WHERE role='division_manager' AND division_id=$1 ORDER BY id ASC LIMIT 1",
    [divisionId]
  );
  if (dm.rowCount) return { assigneeId: dm.rows[0].id, reason: "fallback.division_manager" };

  return { assigneeId: null, reason: "fallback.none" };
}

async function loadRequestForPdf(reqId) {
  const rq = await q(
    `SELECT
       r.*,
       ag.first_name  AS agent_first,
       ag.last_name   AS agent_last,
       ag.email       AS agent_email,
       ag.pda_number  AS agent_pda,
       d.name         AS division_name,
       b.code         AS buyer_code,
       b.name         AS buyer_name,
       s.site_code,
       s.site_name,
       a.sku          AS single_sku,
       a.name         AS single_name,
       a.sell_price   AS single_price
     FROM requests r
     JOIN users ag ON ag.id=r.agent_id
     LEFT JOIN divisions d ON d.id=r.division_id
     JOIN buyers b ON b.id=r.buyer_id
     LEFT JOIN buyer_sites s ON s.id=r.site_id
     LEFT JOIN articles a  ON a.id=r.article_id
     WHERE r.id=$1`,
    [reqId]
  );
  if (!rq.rowCount) throw new Error("Request not found");
  const reqRow = rq.rows[0];

  const itemsRes = await q(
    `SELECT ri.article_id, ri.quantity, ri.line_amount, a.sku, a.name, a.sell_price
       FROM request_items ri
       JOIN articles a ON a.id=ri.article_id
      WHERE ri.request_id=$1
      ORDER BY ri.id`,
    [reqId]
  );
  let items = itemsRes.rows;
  if (!items.length && reqRow.article_id) {
    items = [{
      article_id: reqRow.article_id,
      quantity:   reqRow.quantity || 1,
      line_amount: reqRow.amount,
      sku: reqRow.single_sku,
      name: reqRow.single_name,
      sell_price: reqRow.single_price,
    }];
  }

  const approvals = await q(
    `SELECT a.*, u.first_name, u.last_name
       FROM approvals a
       JOIN users u ON u.id=a.approver_id
      WHERE a.request_id=$1
      ORDER BY a.acted_at`,
    [reqId]
  );

  return { reqRow, items, approvals: approvals.rows };
}

/* ----------------------------- PDF BUILDER ------------------------------- */
function pdfFromRequestRows({ reqRow, items, approvals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

/* --------------------- PDF_ITEM_NORMALIZER (auto) --------------------- */
items = (items || []).map((it) => {
  const qtyRaw  = it?.quantity ?? it?.qty ?? 0;
  const unitRaw = it?.sell_price ?? it?.price ?? it?.unit_price ?? 0;
  const lineRaw = it?.line_amount ?? it?.amount ?? it?.sum ?? 0;

  const qty  = Number(qtyRaw)  || 0;
  const unit = Number(unitRaw) || 0;
  const line = Number(lineRaw) || 0;

  let disc = it?.discount_percent ?? it?.discount ?? it?.percent ?? it?.lejimi;
  disc = disc == null || disc === "" ? NaN : Number(disc);

  if (!Number.isFinite(disc) && qty > 0 && unit > 0) {
    const gross = qty * unit;
    if (gross > 0) disc = (1 - (line / gross)) * 100;
  }

  if (!Number.isFinite(disc)) disc = 0;
  disc = Math.max(0, Math.min(100, disc));
  const discRounded = Math.round(disc * 100) / 100;

  return {
    ...it,
    quantity: qty,
    sell_price: unit,
    price: unit,
    unit_price: unit,
    line_amount: line,
    discount_percent: discRounded,
    discount: discRounded,
    percent: discRounded,
    lejimi: discRounded,
  };
});
/* ---------------------------------------------------------------------- */


    const fontReg  = process.env.PDF_FONT_REG  || "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    const fontBold = process.env.PDF_FONT_BOLD || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

    const hasReg  = fs.existsSync(fontReg);
    const hasBold = fs.existsSync(fontBold);

    if (hasReg)  doc.registerFont("regular", fontReg);
    if (hasBold) doc.registerFont("bold", fontBold);

    const useFont = (name) => {
      try {
        doc.font(name);
      } catch {
        doc.font("Helvetica");
      }
    };

    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    const fmtDate = (d) => {
      try { return new Date(d).toLocaleString(); } catch { return String(d || ""); }
    };

    const fmtMoney = (n) => (Number(n || 0)).toFixed(2);

    const hr = () => {
      const y = doc.y + 6;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor("#d0d0d0").stroke();
      doc.moveDown(1.0);
    };

    const section = (title) => {
      doc.moveDown(0.8);
      useFont(hasBold ? "bold" : "Helvetica-Bold");
      doc.fontSize(11).fillColor("#111").text(title, left, doc.y);
      hr();
      useFont(hasReg ? "regular" : "Helvetica");
      doc.fontSize(9.5).fillColor("#333");
    };

    useFont(hasBold ? "bold" : "Helvetica-Bold");
    doc.fontSize(16).fillColor("#111").text("KËRKESË PËR LEJIM FINANCIAR", { align: "center" });

    useFont(hasReg ? "regular" : "Helvetica");
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#111").text(`#${reqRow.id} – ${fmtDate(reqRow.created_at)}`, { align: "center" });
    doc.moveDown(0.7);

    section("TË DHËNAT E AGJENTIT");
    doc.text(`Agjenti: ${reqRow.agent_first || ""} ${reqRow.agent_last || ""}`.trim());
    doc.text(`PDA: ${reqRow.agent_pda || "-"}`);
    doc.text(`Divizioni: ${reqRow.division_name || "-"}`);

    section("TË DHËNAT E BLERJES");
    doc.text(`Blerësi: ${(reqRow.buyer_code || "").toString()} ${reqRow.buyer_name || "-"}`.trim());
    doc.text(`Objekti: ${reqRow.site_code ? (reqRow.site_code + " " + (reqRow.site_name || "")) : "-"}`);
    doc.text(`Nr. ndryshimit të faturës: ${reqRow.invoice_ref || "-"}`);
    doc.text(`Arsyeja: ${reqRow.reason || "-"}`);

    section("ARTIKUJT");

    const cols = [
      { t: "SKU",      w: 80,  a: "center" },
      { t: "Artikulli",w: 205, a: "center" },
      { t: "Çmimi (€)",w: 60,  a: "center" },
      { t: "Sasia",    w: 50,  a: "center" },
      { t: "Lejimi (%)",w: 60, a: "center" },
      { t: "Shuma (€)",w: 60,  a: "center" },
    ];

    const rowH = 22;
    const drawRow = (cells, isHeader = false) => {
      if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        section("ARTIKUJT");
        drawRow(cols.map(c => c.t), true);
      }

      const y = doc.y;
      let x = left;

      for (let i = 0; i < cols.length; i++) {
        const w = cols[i].w;

        doc.save();
        if (isHeader) {
          doc.rect(x, y, w, rowH).fillAndStroke("#f0f0f0", "#cccccc");
        } else {
          doc.rect(x, y, w, rowH).strokeColor("#cccccc").stroke();
        }
        doc.restore();

        useFont((isHeader && hasBold) ? "bold" : (hasReg ? "regular" : (isHeader ? "Helvetica-Bold" : "Helvetica")));
        doc.fontSize(9.5).fillColor("#111");

        const pad = 6;
        doc.text(String(cells[i] ?? ""), x + pad, y + 6, { width: w - pad*2, align: cols[i].a });

        x += w;
      }

      doc.y = y + rowH;
    };

    drawRow(cols.map(c => c.t), true);

    const safeItems = Array.isArray(items) ? items : [];
    let total = 0;

    for (const it of safeItems) {
      const sku   = it.sku || it.article_sku || "";
      const name  = it.article_name || it.name || "";
      const price = it.unit_price ?? it.price ?? "";
      const qty   = it.quantity ?? it.qty ?? "";
      const disc  = it.discount_pct ?? it.discount ?? it.levy_pct ?? "";
      const sum   = it.line_amount ?? it.total ?? it.sum ?? 0;

      total += Number(sum || 0);

      drawRow([
        sku,
        name,
        price !== "" ? fmtMoney(price) : "",
        qty !== "" ? String(qty) : "",
        disc !== "" ? (String(Number(disc)).includes("%") ? String(disc) : `${Number(disc).toFixed(2)}%`) : "",
        fmtMoney(sum),
      ], false);
    }

    doc.moveDown(0.4);
    useFont(hasBold ? "bold" : "Helvetica-Bold");
    doc.fontSize(10).fillColor("#111").text(`Totali: €${fmtMoney(total)}`, { align: "right" });

    section("STATUSI I KËRKESËS");

    const status = (reqRow.status || "").toLowerCase();
    const label = status === "approved" ? "E aprovuar" : status === "rejected" ? "E refuzuar" : "Në pritje";
    const color = status === "approved" ? "green" : status === "rejected" ? "#b00020" : "#333333";

    useFont(hasReg ? "regular" : "Helvetica");
    doc.fontSize(9.5).fillColor("#111").text("Statusi: ", { continued: true });
    useFont(hasBold ? "bold" : "Helvetica-Bold");
    doc.fillColor(color).text(label);
    doc.fillColor("#111");

    const last = Array.isArray(approvals) && approvals.length ? approvals[approvals.length - 1] : null;
    const approvedBy = (last?.approver_role || reqRow.required_role || "-");
    useFont(hasReg ? "regular" : "Helvetica");
    doc.fontSize(9.5).text(`Aprovuar nga: ${approvedBy}`);

    section("DETALJE TË APROVIMIT");

    if (last) {
      doc.text(`Data & ora: ${fmtDate(last.acted_at)}`);
      doc.text(`Përdoruesi: ${(last.approver_name || last.approver_email || "-")} (${last.approver_role || "-"})`);
      doc.text(`Koment: ${last.comment || "-"}`);
    } else {
      doc.text("S’ka ende aprovim/refuzim.");
    }

    doc.end();
  });
}
/* ------------------------------- SMTP / EMAIL ---------------------------- */
const SMTP_PORT   = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE ?? (SMTP_PORT === 465)).toLowerCase() === "true";

const mailTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  greetingTimeout: 15000,
  connectionTimeout: 15000,
  socketTimeout: 20000,
  tls: { rejectUnauthorized: true, servername: process.env.SMTP_HOST },
  logger: true,
  debug: true,
});
mailTransport.verify().then(
  () => console.log("SMTP OK:", { host: process.env.SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE }),
  (e) => console.error("SMTP ERR:", e?.message || e)
);
async function sendMail({ to, cc, subject, html, attachments }) {
  const toList = Array.isArray(to) ? to.filter(Boolean) : (to ? [to] : []);
  const ccList = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);

  if (!toList.length) return; // pa marrï¿½s, mos dï¿½rgo

  const info = await mailTransport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: toList,
    cc: ccList,
    subject,
    html,
    attachments,
  });
  console.log("MAIL_OK:", info.messageId, "=>", [...toList, ...ccList].join(", "));
  return info;
}

/* --------------------------------- HEALTH -------------------------------- */
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------------------------------- AUTH --------------------------------- */
/* ---------------------------------- AUTH --------------------------------- */
function getIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString();
  return (xf.split(",")[0] || req.socket?.remoteAddress || "").trim();
}

function parseCookies(req) {
  const h = (req.headers.cookie || "").toString();
  const out = {};
  h.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  });
  return out;
}

function setCookie(res, name, value, { maxAgeSeconds } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${COOKIE_SECURE ? "; Secure" : ""}`);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function authEvent(userId, event, req, meta = {}) {
  try {
    await q(
      "INSERT INTO auth_events(user_id,event,ip,user_agent,meta) VALUES($1,$2,$3,$4,$5::jsonb)",
      [userId || null, event, getIp(req), String(req.headers["user-agent"] || ""), JSON.stringify(meta)]
    );
  } catch {}
}

const loginBuckets = new Map();
function rateLimit(key, { limit = 20, windowMs = 5 * 60_000 } = {}) {
  const now = Date.now();
  const b = loginBuckets.get(key) || { n: 0, t: now };
  if (now - b.t > windowMs) { b.n = 0; b.t = now; }
  b.n += 1;
  loginBuckets.set(key, b);
  return b.n <= limit;
}

async function issueRefreshToken(userId, req) {
  if (!REFRESH_PEPPER) return null;
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(token + REFRESH_PEPPER);

  // 30 days default
  const days = Number(process.env.REFRESH_DAYS || 30);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await q(
    "INSERT INTO refresh_tokens(user_id, token_hash, expires_at, user_agent, ip) VALUES($1,$2,$3,$4,$5)",
    [userId, tokenHash, expiresAt, String(req.headers["user-agent"] || ""), getIp(req)]
  );

  return { token, expiresAt };
}

app.post("/auth/login", async (req, res) => {
  try {
    const ip = getIp(req);
    if (!rateLimit(ip)) return res.status(429).json({ error: "Too many attempts" });

    const { email, password } = req.body ?? {};
    if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

    const r = await q(
      "SELECT id,email,password_hash,role,division_id,pda_number,first_name,last_name,failed_login_attempts,locked_until,is_disabled FROM users WHERE email=$1",
      [email]
    );
    if (!r.rowCount) {
      await authEvent(null, "login_failed_no_user", req, { email });
      return res.status(401).json({ error: "Invalid creds" });
    }

    const u = r.rows[0];
    if (u.is_disabled) {
      await authEvent(u.id, "login_blocked_disabled", req);
      return res.status(403).json({ error: "Disabled" });
    }

    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      await authEvent(u.id, "login_blocked_locked", req, { locked_until: u.locked_until });
      return res.status(423).json({ error: "Locked" });
    }

    if (!u.password_hash) return res.status(401).json({ error: "Invalid creds" });
    const ok = await compare(password, u.password_hash);
    if (!ok) {
      // best-effort: lockout after N attempts
      try {
        const max = Number(process.env.LOGIN_MAX_ATTEMPTS || 6);
        const lockMinutes = Number(process.env.LOGIN_LOCK_MINUTES || 15);
        const upd = await q(
          `UPDATE users
             SET failed_login_attempts = COALESCE(failed_login_attempts,0) + 1,
                 locked_until = CASE WHEN (COALESCE(failed_login_attempts,0) + 1) >= $2 THEN (NOW() + ($3 || ' minutes')::interval) ELSE locked_until END
           WHERE id=$1
           RETURNING failed_login_attempts, locked_until`,
          [u.id, max, lockMinutes]
        );
        await authEvent(u.id, "login_failed_bad_password", req, { attempts: upd.rows?.[0]?.failed_login_attempts, locked_until: upd.rows?.[0]?.locked_until });
      } catch (err) {
        if (pgCode(err) !== "42703") console.warn("LOGIN_LOCKOUT_WARN:", err.message);
        await authEvent(u.id, "login_failed_bad_password", req);
      }
      return res.status(401).json({ error: "Invalid creds" });
    }

    // reset lockout fields (best-effort)
    try {
      await q("UPDATE users SET last_login=NOW(), failed_login_attempts=0, locked_until=NULL WHERE id=$1", [u.id]);
    } catch (err) {
      if (pgCode(err) !== "42703") console.warn("LOGIN_RESET_WARN:", err.message);
    }

    const refresh = await issueRefreshToken(u.id, req);
    if (refresh) {
      const maxAge = Math.floor((refresh.expiresAt.getTime() - Date.now()) / 1000);
      setCookie(res, "refresh_token", refresh.token, { maxAgeSeconds: maxAge });
    }

    await authEvent(u.id, "login_success", req);

    res.json({
      token: signJWT(u),
      profile: {
        id: u.id,
        first_name: u.first_name,
        last_name: u.last_name,
        role: u.role,
        division_id: u.division_id,
        pda_number: u.pda_number,
      },
      refresh_enabled: !!REFRESH_PEPPER,
    });
  } catch (e) {
    console.error("LOGIN_ERR:", e);
    res.status(500).json({ error: "server", detail: e.message });
  }
});

app.post("/auth/refresh", async (req, res) => {
  try {
    if (!REFRESH_PEPPER) return res.status(400).json({ error: "disabled" });
    const cookies = parseCookies(req);
    const token = cookies.refresh_token;
    if (!token) return res.status(401).json({ error: "No refresh token" });

    const tokenHash = sha256Hex(token + REFRESH_PEPPER);
    const r = await q(
      "SELECT id,user_id,expires_at,revoked_at FROM refresh_tokens WHERE token_hash=$1 LIMIT 1",
      [tokenHash]
    );
    if (!r.rowCount) return res.status(401).json({ error: "Invalid refresh token" });
    const rt = r.rows[0];
    if (rt.revoked_at) return res.status(401).json({ error: "Revoked" });
    if (new Date(rt.expires_at).getTime() <= Date.now()) return res.status(401).json({ error: "Expired" });

    const ures = await q("SELECT id,email,role,division_id FROM users WHERE id=$1", [rt.user_id]);
    if (!ures.rowCount) return res.status(401).json({ error: "Invalid user" });

    // rotate
    await q("UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1", [rt.id]);
    const fresh = await issueRefreshToken(rt.user_id, req);
    const maxAge = Math.floor((fresh.expiresAt.getTime() - Date.now()) / 1000);
    setCookie(res, "refresh_token", fresh.token, { maxAgeSeconds: maxAge });

    await authEvent(rt.user_id, "refresh_success", req);

    res.json({ token: signJWT(ures.rows[0]) });
  } catch (e) {
    console.error("REFRESH_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies.refresh_token;
    if (token && REFRESH_PEPPER) {
      const tokenHash = sha256Hex(token + REFRESH_PEPPER);
      try {
        const r = await q("UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=$1 RETURNING user_id", [tokenHash]);
        if (r.rowCount) await authEvent(r.rows[0].user_id, "logout", req);
      } catch {}
    }
    clearCookie(res, "refresh_token");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "server" });
  }
});



/* ----------------------------- ADMIN LIST/CRUD --------------------------- */
/** DIVISIONS */
app.get("/admin/divisions", requireAuth, requireRole("admin"), async (_req, res) => {
  const r = await q("SELECT id,name,default_team_leader_id FROM divisions ORDER BY id");
  res.json(r.rows);
});
app.post("/admin/divisions", requireAuth, requireRole("admin"), async (req, res) => {
  const name = (req.body?.name || "").trim();
  const default_team_leader_id = req.body?.default_team_leader_id ?? null;
  if (!name) return res.status(400).json({ error: "Emri mungon" });
  const r = await q("INSERT INTO divisions(name) VALUES($1) RETURNING id", [name]);
  res.json({ id: r.rows[0].id });
});

app.put("/admin/divisions/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body?.name || "").trim();
  let default_team_leader_id = req.body?.default_team_leader_id;

  if (!id) return res.status(400).json({ error: "id" });
  if (!name) return res.status(400).json({ error: "Emri mungon" });

  if (default_team_leader_id === "") default_team_leader_id = null;

  if (default_team_leader_id !== null && default_team_leader_id !== undefined) {
    default_team_leader_id = Number(default_team_leader_id);
    if (!Number.isFinite(default_team_leader_id)) {
      return res.status(400).json({ error: "default_team_leader_id invalid" });
    }
    const chk = await q(
      "SELECT 1 FROM users WHERE id=$1 AND role='team_lead' AND division_id=$2",
      [default_team_leader_id, id]
    );
    if (!chk.rowCount) {
      return res.status(400).json({ error: "default_team_leader_id must be team lead of this division" });
    }
  } else {
    const cur = await q("SELECT default_team_leader_id FROM divisions WHERE id=$1", [id]);
    default_team_leader_id = cur.rows?.[0]?.default_team_leader_id ?? null;
  }

  await q("UPDATE divisions SET name=$1, default_team_leader_id=$2 WHERE id=$3", [
    name,
    default_team_leader_id || null,
    id,
  ]);

  res.json({ ok: true });
});

app.delete("/admin/divisions/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });

  const inUsers = await q("SELECT 1 FROM users WHERE division_id=$1 LIMIT 1", [id]);
  if (inUsers.rowCount) return res.status(409).json({ error: "in_use" });
  const inReq = await q("SELECT 1 FROM requests WHERE division_id=$1 LIMIT 1", [id]);
  if (inReq.rowCount) return res.status(409).json({ error: "in_use" });

  try {
    await q("DELETE FROM divisions WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    // FK violation safety net
    if (e?.code === "23503") return res.status(409).json({ error: "in_use" });
    console.error("DIVISION_DELETE_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

/** ARTICLES */
app.get("/admin/articles", requireAuth, requireRole("admin"), async (_req, res) => {
  const r = await q(`
    SELECT
      id,
      sku,
      name,
      sell_price,
      division_id,
      special_rabat,
      special_rabat_from,
      special_rabat_to
    FROM articles
    ORDER BY id
  `);
  res.json(r.rows);
});

app.post("/admin/articles", requireAuth, requireRole("admin"), async (req, res) => {
  const sku = (req.body?.sku || "").trim();
  const name = (req.body?.name || "").trim();
  const price = req.body?.sell_price === "" || req.body?.sell_price == null ? null : Number(req.body.sell_price);
  if (!sku || !name) return res.status(400).json({ error: "SKU dhe Emri janï¿½ tï¿½ detyrueshme" });
  const r = await q("INSERT INTO articles(sku,name,sell_price) VALUES($1,$2,$3) RETURNING id", [sku, name, price]);
  res.json({ id: r.rows[0].id });
});

app.put("/admin/articles/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const sku = (req.body?.sku || "").trim();
  const name = (req.body?.name || "").trim();
  const price = req.body?.sell_price === "" || req.body?.sell_price == null ? null : Number(req.body.sell_price);
  if (!id) return res.status(400).json({ error: "id" });
  if (!sku || !name) return res.status(400).json({ error: "SKU dhe Emri janë të detyrueshme" });

  try {
    await q("UPDATE articles SET sku=$1,name=$2,sell_price=$3 WHERE id=$4", [sku, name, price, id]);
    res.json({ ok: true });
  } catch (e) {
    if (e?.code === "23505") return res.status(409).json({ error: "duplicate" });
    console.error("ARTICLE_UPDATE_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

app.delete("/admin/articles/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });

  const inReq = await q("SELECT 1 FROM requests WHERE article_id=$1 LIMIT 1", [id]);
  if (inReq.rowCount) return res.status(409).json({ error: "in_use" });

  const hasItems = await regclassExists("request_items");
  if (hasItems) {
    const inItems = await q("SELECT 1 FROM request_items WHERE article_id=$1 LIMIT 1", [id]);
    if (inItems.rowCount) return res.status(409).json({ error: "in_use" });
  }

  try {
    await q("DELETE FROM articles WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    if (e?.code === "23503") return res.status(409).json({ error: "in_use" });
    console.error("ARTICLE_DELETE_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

/** BUYERS */
app.get("/admin/buyers", requireAuth, requireRole("admin"), async (_req, res) => {
  const r = await q("SELECT id,code,name FROM buyers ORDER BY id");
  res.json(r.rows);
});
app.post("/admin/buyers", requireAuth, requireRole("admin"), async (req, res) => {
  const code = (req.body?.code || "").trim();
  const name = (req.body?.name || "").trim();
  if (!code || !name) return res.status(400).json({ error: "Kodi dhe Emri janï¿½ tï¿½ detyrueshme" });
  const r = await q("INSERT INTO buyers(code,name) VALUES($1,$2) RETURNING id", [code, name]);
  res.json({ id: r.rows[0].id });
});

app.put("/admin/buyers/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });

  const code = (req.body?.code || "").trim();
  const name = (req.body?.name || "").trim();
  if (!code || !name) return res.status(400).json({ error: "Kodi dhe Emri janë të detyrueshme" });

  try {
    const dupe = await q("SELECT 1 FROM buyers WHERE code=$1 AND id<>$2", [code, id]);
    if (dupe.rowCount) return res.status(409).json({ error: "duplicate_code" });

    const r = await q("UPDATE buyers SET code=$1,name=$2 WHERE id=$3", [code, name, id]);
    if (!r.rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "duplicate" });
    console.error("ADMIN_BUYERS_PUT_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

app.delete("/admin/buyers/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });

  try {
    const inReq = await q("SELECT 1 FROM requests WHERE buyer_id=$1 LIMIT 1", [id]);
    if (inReq.rowCount) return res.status(409).json({ error: "in_use" });
    const inSites = await q("SELECT 1 FROM buyer_sites WHERE buyer_id=$1 LIMIT 1", [id]);
    if (inSites.rowCount) return res.status(409).json({ error: "in_use" });

    const r = await q("DELETE FROM buyers WHERE id=$1", [id]);
    if (!r.rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23503") return res.status(409).json({ error: "in_use" });
    console.error("ADMIN_BUYERS_DEL_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

/** BUYER SITES */
app.get("/admin/buyer-sites", requireAuth, requireRole("admin"), async (req, res) => {
  const { buyer_id } = req.query;
  const sql =
    "SELECT id,buyer_id,site_code,site_name FROM buyer_sites " +
    (buyer_id ? "WHERE buyer_id=$1 " : "") +
    "ORDER BY id";
  const r = await q(sql, buyer_id ? [Number(buyer_id)] : []);
  res.json(r.rows);
});
app.post("/admin/buyer-sites", requireAuth, requireRole("admin"), async (req, res) => {
  const buyer_id = Number(req.body?.buyer_id);
  const site_code = (req.body?.site_code || "").trim();
  const site_name = (req.body?.site_name || "").trim();
  if (!buyer_id) return res.status(400).json({ error: "buyer_id mungon" });
  if (!site_code || !site_name) return res.status(400).json({ error: "Kodi/Emri i objektit mungon" });
  const r = await q(
    "INSERT INTO buyer_sites(buyer_id,site_code,site_name) VALUES($1,$2,$3) RETURNING id",
    [buyer_id, site_code, site_name]
  );
  res.json({ id: r.rows[0].id });
});

app.put("/admin/buyer-sites/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });

  const buyer_id = Number(req.body?.buyer_id);
  const site_code = (req.body?.site_code || "").trim();
  const site_name = (req.body?.site_name || "").trim();
  if (!buyer_id) return res.status(400).json({ error: "buyer_id mungon" });
  if (!site_code || !site_name) return res.status(400).json({ error: "Kodi/Emri i objektit mungon" });

  try {
    const dupe = await q(
      "SELECT 1 FROM buyer_sites WHERE buyer_id=$1 AND site_code=$2 AND id<>$3",
      [buyer_id, site_code, id]
    );
    if (dupe.rowCount) return res.status(409).json({ error: "duplicate_code" });

    const r = await q(
      "UPDATE buyer_sites SET buyer_id=$1,site_code=$2,site_name=$3 WHERE id=$4",
      [buyer_id, site_code, site_name, id]
    );
    if (!r.rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "duplicate" });
    console.error("ADMIN_SITES_PUT_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

app.delete("/admin/buyer-sites/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });

  try {
    const inReq = await q("SELECT 1 FROM requests WHERE site_id=$1 LIMIT 1", [id]);
    if (inReq.rowCount) return res.status(409).json({ error: "in_use" });

    const r = await q("DELETE FROM buyer_sites WHERE id=$1", [id]);
    if (!r.rowCount) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23503") return res.status(409).json({ error: "in_use" });
    console.error("ADMIN_SITES_DEL_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

/** SYNC (MSSQL API -> Postgres) */
app.post(
  "/admin/sync/articles",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const out = await syncArticlesFromMssqlApi(req);
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error("SYNC_ARTICLES_ERR:", e);
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);
/** SYNC (MSSQL API -> Postgres) 	DIVISIONS*/
app.post("/admin/sync/divisions", requireAuth, requireRole("admin"), async (_req, res) => {
  try {
    const out = await syncDivisionsFromMssqlApi();
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


/** USERS (create/list/edit/delete) */
app.post("/admin/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { first_name, last_name, email, password, role, division_id, pda_number, team_leader_id } = req.body ?? {};
    if (!email?.trim() || !password?.trim())
      return res.status(400).json({ error: "Email dhe password janï¿½ tï¿½ detyrueshme" });
    const ph = await hash(password);
// VALIDATE_TEAM_LEADER
let tlId = team_leader_id || null;
if (role !== "agent") tlId = null;
if (tlId) {
  const chkTl = await q(
    "SELECT 1 FROM users WHERE id=$1 AND role='team_lead' AND division_id=$2",
    [tlId, division_id || null]
  );
  if (!chkTl.rowCount) return res.status(400).json({ error: "team_leader_id invalid" });
}

    const r = await q(
      "INSERT INTO users(first_name,last_name,email,password_hash,role,division_id,pda_number,team_leader_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [first_name || "", last_name || "", email.trim(), ph, role, division_id || null, pda_number || null, tlId]
    );
    res.json({ id: r.rows[0].id });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Ky email ekziston" });
    console.error("ADMIN_CREATE_USER_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

app.get("/admin/users", requireAuth, requireRole("admin"), async (_req, res) => {
  const r = await q(
    `SELECT u.id,u.first_name,u.last_name,u.email,u.role,u.division_id,
            d.name AS division_name,u.pda_number,u.team_leader_id,u.created_at
       FROM users u
       LEFT JOIN divisions d ON d.id=u.division_id
      ORDER BY u.id`
  );
  res.json(r.rows);
});

app.put("/admin/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const { first_name = "", last_name = "", email = "", password = "", role, division_id, pda_number, team_leader_id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id" });

  try {
    if (email) {
      const chk = await q("SELECT 1 FROM users WHERE email=$1 AND id<>$2", [email, id]);
      if (chk.rowCount) return res.status(409).json({ error: "Ky email ekziston" });
    }
    
// VALIDATE_TEAM_LEADER_UPDATE
let tlId = team_leader_id || null;
if (role !== "agent") tlId = null;
if (tlId) {
  const chkTl = await q(
    "SELECT 1 FROM users WHERE id=$1 AND role='team_lead' AND division_id=$2",
    [tlId, division_id || null]
  );
  if (!chkTl.rowCount) return res.status(400).json({ error: "team_leader_id invalid" });
}

if (password && password.trim()) {
      const ph = await hash(password.trim());
      await q(
        "UPDATE users SET first_name=$1,last_name=$2,email=$3,password_hash=$4,role=$5,division_id=$6,pda_number=$7,team_leader_id=$8 WHERE id=$9",
        [first_name, last_name, email, ph, role, division_id || null, pda_number || null, tlId, id]
      );
    } else {
      await q(
        "UPDATE users SET first_name=$1,last_name=$2,email=$3,role=$4,division_id=$5,pda_number=$6,team_leader_id=$7 WHERE id=$8",
        [first_name, last_name, email, role, division_id || null, pda_number || null, tlId, id]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("ADMIN_UPDATE_USER_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});

app.delete("/admin/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "id" });
  try {
    await q("DELETE FROM users WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("ADMIN_DELETE_USER_ERR:", e);
    res.status(500).json({ error: "server" });
  }
});
/* --------------------------- /ADMIN routes end --------------------------- */

/* ----------------------------------- META -------------------------------- */
app.get("/meta", requireAuth, async (req, res) => {
  const [buyers, sites, articles, me] = await Promise.all([
    q("SELECT id,code,name FROM buyers ORDER BY code"),
    q("SELECT id,buyer_id,site_code,site_name FROM buyer_sites ORDER BY site_code"),
    q(`
  SELECT
    id,
    sku,
    name,
    sell_price,
    division_id,
    special_rabat,
    special_rabat_from,
    special_rabat_to
  FROM articles
  ORDER BY sku
`),

    q("SELECT u.id,u.first_name,u.last_name,u.pda_number,u.division_id,d.name as division_name FROM users u LEFT JOIN divisions d ON d.id=u.division_id WHERE u.id=$1", [req.user.id]),
  ]);
  res.json({ buyers: buyers.rows, sites: sites.rows, articles: articles.rows, me: me.rows[0] });
});

/* --------------------------- REQUESTS / APPROVALS ------------------------ */
// Krijimi i kï¿½rkesï¿½s + shumï¿½ foto (field name: "photos")
app.post(
  "/requests",
  requireAuth,
  requireRole("agent", "admin"),
  upload.array("photos", 10),
  async (req, res) => {
    try {
      const idemKey = String(req.get("Idempotency-Key") || "").trim();
      if (idemKey && (idemKey.length < 8 || idemKey.length > 128)) {
        return res.status(400).json({ error: "Invalid Idempotency-Key" });
      }

      const parseMaybeJson = (v) => {
        if (v == null || v === "") return null;
        if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
        return v;
      };

      const { buyer_id, site_id, article_id, quantity = 1, amount, invoice_ref, reason } = req.body;
      let items = parseMaybeJson(req.body.items);

      const out = await withTx(async (qx) => {
        if (idemKey) {
          const ex = await qx(
            "SELECT id FROM requests WHERE agent_id=$1 AND idempotency_key=$2 ORDER BY id DESC LIMIT 1",
            [req.user.id, idemKey]
          );
          if (ex.rowCount) {
            const reqId = ex.rows[0].id;
            const ph = await qx("SELECT url FROM request_photos WHERE request_id=$1 ORDER BY id", [reqId]);
            return { id: reqId, photo_urls: ph.rows.map((r) => r.url), idempotent: true };
          }
        }

        const buyerIdClean = cleanId(buyer_id);
        if (!buyerIdClean) throw Object.assign(new Error("Zgjedh blerësin (buyer_id)"), { status: 400 });
        const siteIdClean = cleanId(site_id);

        const me = await qx("SELECT division_id,email,first_name,last_name FROM users WHERE id=$1", [req.user.id]);
        const division_id = me.rows[0].division_id;

        let totalAmount = 0;
        let normalizedItems = [];

        if (Array.isArray(items) && items.length > 0) {
          const ids = [...new Set(items.map((i) => Number(i.article_id)).filter(Boolean))];
          const priceById = new Map();
          if (ids.length) {
            const prices = await qx("SELECT id, sell_price FROM articles WHERE id = ANY($1::int[])", [ids]);
            prices.rows.forEach((r) => priceById.set(r.id, Number(r.sell_price)));
          }
          normalizedItems = items.map((i) => {
            const qty = Number(i.quantity || 1);
            const aid = Number(i.article_id);
            const la  = i.line_amount != null ? Number(i.line_amount) : Number((priceById.get(aid) || 0) * qty);
            return { article_id: aid, quantity: qty, line_amount: la };
          });
          totalAmount = normalizedItems.reduce((s, it) => s + (Number(it.line_amount) || 0), 0);
        } else {
          totalAmount = Number(amount || 0);
        }

        const photo_urls = Array.isArray(req.files) ? req.files.map((f) => `/uploads/${f.filename}`) : [];
        const needed = requiredRoleForAmount(totalAmount);

        let assigned_to_user_id = null;
        let assigned_reason = null;
        let assigned_at = null;
        if (needed === "team_lead") {
          const asg = await resolveTeamLeadAssignee({ agentId: req.user.id, divisionId: division_id, qfn: qx });
          assigned_to_user_id = asg.assigneeId;
          assigned_reason = asg.reason;
          assigned_at = asg.assigneeId ? new Date() : null;
        }

        const r = await qx(
          `INSERT INTO requests(
            agent_id,division_id,buyer_id,site_id,article_id,quantity,amount,invoice_ref,reason,photo_url,required_role,assigned_to_user_id,assigned_reason,assigned_at,idempotency_key
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [
            req.user.id,
            division_id,
            buyerIdClean,
            siteIdClean,
            Array.isArray(items) && items.length > 0 ? null : (article_id || null),
            Array.isArray(items) && items.length > 0 ? null : (quantity || 1),
            totalAmount,
            invoice_ref || null,
            reason || null,
            photo_urls[0] || null, // compatibility
            needed,
            assigned_to_user_id,
            assigned_reason,
            assigned_at,
            idemKey || null,
          ]
        );
        const reqId = r.rows[0].id;

        if (normalizedItems.length) {
          const values = normalizedItems.flatMap((it) => [reqId, it.article_id, it.quantity, it.line_amount]);
          const placeholders = normalizedItems
            .map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`)
            .join(",");
          await qx(`INSERT INTO request_items(request_id,article_id,quantity,line_amount) VALUES ${placeholders}`, values);
        }

        if (photo_urls.length) {
          const vals = photo_urls.flatMap((u) => [reqId, u]);
          const ph = photo_urls.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(",");
          await qx(`INSERT INTO request_photos(request_id,url) VALUES ${ph}`, vals);
        }

        // audit (best-effort)
        try {
          await qx(
            "INSERT INTO request_events(request_id,actor_user_id,event,meta) VALUES($1,$2,$3,$4::jsonb)",
            [reqId, req.user.id, "created", JSON.stringify({ required_role: needed, amount: totalAmount })]
          );
        } catch {}

        return { id: reqId, photo_urls, idempotent: false };
      });

      // Email only on first create
      if (!out.idempotent) {
        try {
          const { reqRow, items: its, approvals } = await loadRequestForPdf(out.id);
          let to = await approverEmailsFor(reqRow);
          if (!to || !to.length) to = [];
          const pdfBuf = await pdfFromRequestRows({ reqRow, items: its, approvals });
          await sendMail({
            to,
            cc: reqRow.agent_email,
            subject: `[Fin Approvals] Kërkesë #${reqRow.id} — ${reqRow.buyer_code} ${reqRow.buyer_name} — €${fmtMoney(reqRow.amount)}`,
            html: `
              <p>Kërkesë e re nga <b>${reqRow.agent_first} ${reqRow.agent_last}</b>.</p>
              ${out.photo_urls.length ? `<p>Foto (${out.photo_urls.length}): <a href="${PUBLIC_API}${out.photo_urls[0]}">shiko të parën</a></p>` : ``}
              <p><b>Totali:</b> €${fmtMoney(reqRow.amount)} — <b>Kërkohet nga:</b> ${reqRow.required_role}</p>
              <p><a href="${APP_URL}/approvals" target="_blank">Hape listën e aprovimeve</a></p>`,
            attachments: [{ filename: `kerkes-${reqRow.id}.pdf`, content: pdfBuf, contentType: "application/pdf" }],
          });
        } catch (e) {
          console.error("EMAIL_ON_CREATE_ERR:", e?.message || e);
        }
      }

      res.json({ id: out.id, photos: out.photo_urls, idempotent: out.idempotent });
    } catch (e) {
      const status = e?.status || 500;
      console.error("REQ_CREATE_ERR:", e);
      res.status(status).json({ error: status === 400 ? "bad_request" : "server", detail: e?.message || "" });
    }
  }
);


/* --------- Lista e kï¿½rkesave tï¿½ agjentit (ME FILTRA & FAQï¿½ZIM) ---------- */
app.get(
  "/requests/my",
  requireAuth,
  requireRole("agent", "admin"),
  async (req, res) => {
    try {
      const { status, leader, date, from, to, page = "1", per = "10" } = req.query;

      const _page  = Math.max(1, parseInt(page, 10) || 1);
      const _per   = Math.min(50, Math.max(1, parseInt(per, 10) || 10));
      const offset = (_page - 1) * _per;

      const wh = ["r.agent_id = $1"];
      const params = [req.user.id];
      let p = params.length;

      if (status) { wh.push(`r.status = $${++p}`); params.push(String(status)); }
      if (leader) { wh.push(`r.required_role = $${++p}`); params.push(String(leader)); }

      if (date) {
        wh.push(`DATE(r.created_at) = $${++p}`); params.push(String(date));
      } else {
        if (from) { wh.push(`r.created_at >= $${++p}::date`); params.push(String(from)); }
        if (to)   { wh.push(`r.created_at < ($${++p}::date + INTERVAL '1 day')`); params.push(String(to)); }
      }

      const whereSql = `WHERE ${wh.join(" AND ")}`;

      const sqlRows = `
        SELECT
          r.*,
          b.code  AS buyer_code, b.name AS buyer_name,
          s.site_name,
          a.sku, a.name AS article_name,
          COALESCE(
            (SELECT json_agg(json_build_object(
               'article_id', ri.article_id,
               'sku',       aa.sku,
               'name',      aa.name,
               'quantity',  ri.quantity,
               'line_amount', ri.line_amount
            ) ORDER BY ri.id)
             FROM request_items ri
             JOIN articles aa ON aa.id = ri.article_id
            WHERE ri.request_id = r.id),
            '[]'::json
          ) AS items,
          CASE
            WHEN EXISTS (SELECT 1 FROM request_items x WHERE x.request_id = r.id)
              THEN (
                SELECT string_agg(aa.sku || ' x' || ri.quantity, ', ')
                FROM request_items ri
                JOIN articles aa ON aa.id = ri.article_id
                WHERE ri.request_id = r.id
              )
            ELSE a.name
          END AS article_summary,
          COALESCE(
            (SELECT json_agg(p.url ORDER BY p.id)
             FROM request_photos p
             WHERE p.request_id = r.id),
            '[]'::json
          ) AS photos
        FROM requests r
        JOIN buyers b           ON b.id  = r.buyer_id
        LEFT JOIN buyer_sites s ON s.id  = r.site_id
        LEFT JOIN articles a    ON a.id  = r.article_id
        ${whereSql}
        ORDER BY r.id DESC
        LIMIT $${++p} OFFSET $${++p};
      `;
      const rowParams = [...params, _per, offset];

      const sqlTotal = `SELECT COUNT(*)::int AS c FROM requests r ${whereSql};`;

      const [rowsRes, totalRes] = await Promise.all([
        q(sqlRows, rowParams),
        q(sqlTotal, params),
      ]);

      const total = totalRes.rows?.[0]?.c || 0;
      res.json({
        ok: true,
        rows: rowsRes.rows || [],
        page: _page,
        per: _per,
        total,
        pages: Math.max(1, Math.ceil(total / _per)),
      });
    } catch (e) {
      console.error("MY_HISTORY_ERR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  }
);

/* ---------------------- Pending pï¿½r aprovues (photos) -------------------- */
app.get("/approvals/pending", requireAuth, requireRole("team_lead", "division_manager", "sales_director"), async (req, res) => {
  const whereDiv = req.user.role === "team_lead"
    ? "AND r.assigned_to_user_id=$2"
    : (req.user.role === "division_manager" ? "AND r.division_id=$2" : "");
  const params = req.user.role === "team_lead"
    ? [req.user.role, req.user.id]
    : (req.user.role === "division_manager" ? [req.user.role, req.user.division_id] : [req.user.role]);
  const r = await q(
    `SELECT r.*, u.first_name,u.last_name, a.sku, a.name AS article_name, b.code AS buyer_code, s.site_name,
        COALESCE((SELECT json_agg(p.url ORDER BY p.id) FROM request_photos p WHERE p.request_id=r.id),'[]'::json) AS photos,
        COALESCE(
          (SELECT json_agg(json_build_object('article_id', ri.article_id,'sku', aa.sku,'name', aa.name,'quantity', ri.quantity,'line_amount', ri.line_amount) ORDER BY ri.id)
           FROM request_items ri JOIN articles aa ON aa.id=ri.article_id
           WHERE ri.request_id=r.id),'[]'::json) AS items,
        CASE WHEN EXISTS (SELECT 1 FROM request_items x WHERE x.request_id=r.id)
             THEN (SELECT string_agg(aa.sku || ' x' || ri.quantity, ', ') FROM request_items ri JOIN articles aa ON aa.id=ri.article_id WHERE ri.request_id=r.id)
             ELSE a.name END AS article_summary
     FROM requests r
     JOIN users u ON u.id=r.agent_id
     JOIN buyers b ON b.id=r.buyer_id
     LEFT JOIN buyer_sites s ON s.id=r.site_id
     LEFT JOIN articles a ON a.id=r.article_id
     WHERE r.status='pending' AND r.required_role=$1 ${whereDiv}
     ORDER BY r.created_at DESC`,
    params
  );
  res.json(r.rows);
});

/* --------------------- Historia ime si aprovues (photos) ----------------- */
app.get(
  "/approvals/my-history",
  requireAuth,
  requireRole("team_lead", "division_manager", "sales_director"),
  async (req, res) => {
    const r = await q(
      `SELECT
          a.request_id AS id, a.action, a.comment, a.acted_at,
          r.amount, r.status, r.required_role,
          u.first_name AS agent_first, u.last_name AS agent_last,
          b.code AS buyer_code, b.name AS buyer_name,
          s.site_name,
          COALESCE((SELECT json_agg(p.url ORDER BY p.id)
                    FROM request_photos p
                    WHERE p.request_id = r.id),'[]'::json) AS photos
       FROM approvals a
       JOIN requests r ON r.id=a.request_id
       JOIN users   u  ON u.id=r.agent_id
       JOIN buyers  b  ON b.id=r.buyer_id
       LEFT JOIN buyer_sites s ON s.id=r.site_id
       WHERE a.approver_id=$1
       ORDER BY a.acted_at DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  }
);

/* ---------------- Historia e rolit (photos) ï¿½ unik, pa duplikate ---------- */
app.get(
  "/approvals/role-history",
  requireAuth,
  requireRole("team_lead", "division_manager", "sales_director"),
  async (req, res) => {
    const role = req.user.role;
    const whereDiv = role === "sales_director" ? "" : "AND r.division_id = $2";
    const params = role === "sales_director" ? [role] : [role, req.user.division_id];

    const r = await q(
      `SELECT
         a.request_id AS id, a.action, a.comment, a.acted_at,
         r.amount, r.status, r.required_role,
         u.first_name AS agent_first, u.last_name AS agent_last,
         b.code AS buyer_code, b.name AS buyer_name,
         s.site_name,
         COALESCE((SELECT json_agg(p.url ORDER BY p.id)
                   FROM request_photos p
                   WHERE p.request_id = r.id),'[]'::json) AS photos
       FROM approvals a
       JOIN requests r   ON r.id = a.request_id
       JOIN users u      ON u.id = r.agent_id
       JOIN buyers b     ON b.id = r.buyer_id
       LEFT JOIN buyer_sites s ON s.id = r.site_id
       WHERE a.approver_role = $1 ${whereDiv}
       ORDER BY a.acted_at DESC`,
      params
    );
    res.json(r.rows);
  }
);

/* ------------------------- PDF i kï¿½rkesï¿½s (view/download) ---------------- */


/* --------------------- Foto te kerkese (list urls) --------------------- */
app.get("/requests/:id/photos", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id" });

    const r0 = await q("SELECT id, agent_id, division_id, required_role, assigned_to_user_id FROM requests WHERE id=$1", [id]);
    if (!r0.rowCount) return res.status(404).json({ error: "not_found" });
    const reqRow = r0.rows[0];

    if (req.user.role === "agent" && reqRow.agent_id !== req.user.id) {
      return res.status(403).json({ error: "forbidden" });
    }
    if ((req.user.role === "team_lead" || req.user.role === "division_manager") &&
    reqRow.division_id !== req.user.division_id) {
  return res.status(403).json({ error: "forbidden" });
}
if (req.user.role === "team_lead") {
  const assigneeId = reqRow.assigned_to_user_id
    ?? (await resolveTeamLeadAssignee({ agentId: reqRow.agent_id, divisionId: reqRow.division_id })).assigneeId;
  if (!assigneeId || assigneeId !== req.user.id) {
    return res.status(403).json({ error: "forbidden" });
  }
}


    const ph = await q("SELECT url FROM request_photos WHERE request_id=$1 ORDER BY id", [id]);
    res.json((ph.rows || []).map(x => x.url));
  } catch (e) {
    console.error("REQ_PHOTOS_ERR:", e);
    res.status(500).json({ error: "server_error" });
  }
});



/* --------- Historia e te gjithe aprovimeve (vetem per sales_director) --------- */
app.get(
  "/approvals/all-history",
  requireAuth,
  requireRole("sales_director"),
  async (req, res) => {
    try {
      const r = await q(
        `SELECT
            a.request_id AS id, a.action, a.comment, a.acted_at,
            a.approver_role,
            ap.first_name AS approver_first, ap.last_name AS approver_last,
            r.amount, r.status, r.required_role, r.division_id,
            u.first_name AS agent_first, u.last_name AS agent_last,
            b.code AS buyer_code, b.name AS buyer_name,
            s.site_name,
            COALESCE((SELECT json_agg(p.url ORDER BY p.id)
                      FROM request_photos p
                      WHERE p.request_id = r.id),'[]'::json) AS photos
         FROM approvals a
         JOIN users   ap ON ap.id = a.approver_id
         JOIN requests r ON r.id  = a.request_id
         JOIN users   u  ON u.id  = r.agent_id
         JOIN buyers  b  ON b.id  = r.buyer_id
         LEFT JOIN buyer_sites s ON s.id = r.site_id
         ORDER BY a.acted_at DESC`,
        []
      );
      res.json(r.rows);
    } catch (e) {
      console.error("ALL_HIST_ERR:", e);
      res.status(500).json({ error: "server_error" });
    }
  }
);



/* --------- Historia e teamlead (vetem per division_manager) --------- */
app.get(
  "/approvals/teamlead-history",
  requireAuth,
  requireRole("division_manager"),
  async (req, res) => {
    try {
      const r = await q(
        `SELECT
            a.request_id AS id, a.action, a.comment, a.acted_at,
            a.approver_role,
            ap.first_name AS approver_first, ap.last_name AS approver_last,
            r.amount, r.status, r.required_role,
            u.first_name AS agent_first, u.last_name AS agent_last,
            b.code AS buyer_code, b.name AS buyer_name,
            s.site_name,
            COALESCE((SELECT json_agg(p.url ORDER BY p.id)
                      FROM request_photos p
                      WHERE p.request_id = r.id),'[]'::json) AS photos
         FROM approvals a
         JOIN users   ap ON ap.id = a.approver_id
         JOIN requests r ON r.id  = a.request_id
         JOIN users   u  ON u.id  = r.agent_id
         JOIN buyers  b  ON b.id  = r.buyer_id
         LEFT JOIN buyer_sites s ON s.id = r.site_id
         WHERE a.approver_role = 'team_lead'
           AND r.division_id   = $1
         ORDER BY a.acted_at DESC`,
        [req.user.division_id]
      );
      res.json(r.rows);
    } catch (e) {
      console.error("TEAMLEAD_HIST_ERR:", e);
      res.status(500).json({ error: "server_error" });
    }
  }
);

app.get("/requests/:id/pdf", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "id" });

    const { reqRow, items, approvals } = await loadRequestForPdf(id);

    // Siguri minimale: agjenti sheh tï¿½ vetat; aprovuesit brenda rolit/divizionit
    if (req.user.role === "agent" && reqRow.agent_id !== req.user.id) {
      return res.status(403).json({ error: "forbidden" });
    }
    if ((req.user.role === "team_lead" || req.user.role === "division_manager") &&
    reqRow.division_id !== req.user.division_id) {
  return res.status(403).json({ error: "forbidden" });
}
if (req.user.role === "team_lead") {
  const assigneeId = reqRow.assigned_to_user_id
    ?? (await resolveTeamLeadAssignee({ agentId: reqRow.agent_id, divisionId: reqRow.division_id })).assigneeId;
  if (!assigneeId || assigneeId !== req.user.id) {
    return res.status(403).json({ error: "forbidden" });
  }
}


    const pdf = await pdfFromRequestRows({ reqRow, items, approvals });
    res.setHeader("Content-Type", "application/pdf");
    if (req.query.download) {
      res.setHeader("Content-Disposition", `attachment; filename=kerkes-${id}.pdf`);
    }
    return res.send(pdf);
  } catch (e) {
    return res.status(404).json({ error: "not_found" });
  }
});

/* ---------------------- Aprovo/Refuzo kï¿½rkesï¿½ (act) ---------------------- */
async function actOnRequest({ reqId, action, comment, user }) {
  if (!["approved", "rejected"].includes(action)) throw new Error("bad_action");

  const r = await q(
    "SELECT id, status, required_role, division_id, amount, agent_id, assigned_to_user_id FROM requests WHERE id=$1",
    [reqId]
  );
  if (!r.rowCount) throw new Error("not_found");
  const row = r.rows[0];

  if (row.status !== "pending") throw new Error("already_decided");
  if (row.required_role !== user.role) throw new Error("wrong_role");

    if ((user.role === "team_lead" || user.role === "division_manager") && row.division_id !== user.division_id) {
  throw new Error("forbidden");
}

if (user.role === "team_lead") {
  const assigneeId = row.assigned_to_user_id
    ?? (await resolveTeamLeadAssignee({ agentId: row.agent_id, divisionId: row.division_id })).assigneeId;
  if (!assigneeId || assigneeId !== user.id) {
    throw new Error("forbidden");
  }
}


  // regjistro veprimin
  await q(
    "INSERT INTO approvals(request_id, approver_id, approver_role, action, comment, acted_at) VALUES($1,$2,$3,$4,$5,NOW())",
    [reqId, user.id, user.role, action, comment || null]
  );

  // pï¿½rditï¿½so statusin (VETï¿½M NJï¿½ HERï¿½)
  await q("UPDATE requests SET status=$1 WHERE id=$2", [action, reqId]);

  // Dï¿½rgo email FINAL te Lejimet me PDF-in e Pï¿½RDITï¿½SUAR (CC aprovuesin + agjentin)
  try {
    const { reqRow, items, approvals } = await loadRequestForPdf(reqId);
    const pdfBuf = await pdfFromRequestRows({ reqRow, items, approvals });

    const subj = `[Fin Approvals] ${action === "approved" ? "APROVIM" : "REFUZIM"} ï¿½ #${reqId} ï¿½ ï¿½${fmtMoney(reqRow.amount)}`;
    const approverName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
    const html = `<p>Kï¿½rkesa #${reqId} u ${action} nga <b>${approverName || user.email || user.role} (${user.role})</b>.</p>`;

    await sendMail({
      to: process.env.LEJIMET_EMAIL || process.env.FINAL_APPROVAL_EMAIL,
      cc: [reqRow.agent_email, user.email].filter(Boolean),
      subject: subj,
      html,
      attachments: [{ filename: `kerkes-${reqId}.pdf`, content: pdfBuf, contentType: "application/pdf" }],
    });
  } catch (e) {
    console.error("FINAL_MAIL_ERR:", e?.message || e);
  }

  return { ok: true };
}

/* Forma e re: POST /approvals/act { id, action, comment } */
app.post("/approvals/act", requireAuth, requireRole("team_lead", "division_manager", "sales_director"), async (req, res) => {
  try {
    const id = Number(req.body?.id);
    const action = String(req.body?.action || "").toLowerCase();
    const comment = req.body?.comment || "";
    if (!id) return res.status(400).json({ error: "id" });

    const out = await actOnRequest({ reqId: id, action, comment, user: req.user });
    res.json(out);
  } catch (e) {
    const map = { not_found: 404, wrong_role: 403, forbidden: 403, already_decided: 409, bad_action: 400 };
    const code = map[e.message] || 500;
    res.status(code).json({ error: e.message });
  }
});

/* Legacy: POST /approvals/:id/approved  dhe  /approvals/:id/rejected */
app.post("/approvals/:id/approved", requireAuth, requireRole("team_lead", "division_manager", "sales_director"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const comment = req.body?.comment || "";
    const out = await actOnRequest({ reqId: id, action: "approved", comment, user: req.user });
    res.json(out);
  } catch (e) {
    const map = { not_found: 404, wrong_role: 403, forbidden: 403, already_decided: 409 };
    const code = map[e.message] || 500;
    res.status(code).json({ error: e.message });
  }
});

app.post("/approvals/:id/rejected", requireAuth, requireRole("team_lead", "division_manager", "sales_director"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const comment = req.body?.comment || "";
    const out = await actOnRequest({ reqId: id, action: "rejected", comment, user: req.user });
    res.json(out);
  } catch (e) {
    const map = { not_found: 404, wrong_role: 403, forbidden: 403, already_decided: 409 };
    const code = map[e.message] || 500;
    res.status(code).json({ error: e.message });
  }
});

/* ----------------------------- Route printer ----------------------------- */
function printRoutes(app) {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route) {
      const methods = Object.keys(m.route.methods).map((x) => x.toUpperCase()).join(",");
      routes.push(`${methods} ${m.route.path}`);
    } else if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h) => {
        const r = h.route;
        if (r) {
          const methods = Object.keys(r.methods).map((x) => x.toUpperCase()).join(",");
          routes.push(`${methods} ${r.path}`);
        }
      });
    }
  });
  console.log("\n=== ROUTES REGISTERED ===");
  routes.sort().forEach((r) => console.log(r));
  console.log("=========================\n");
}
printRoutes(app);

/* ---------------------------------- START -------------------------------- */
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log("API on", PORT));




