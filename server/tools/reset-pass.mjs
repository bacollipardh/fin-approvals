// server/tools/reset-pass.mjs
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { q } from "../db.js";
import { hash } from "../auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// lexon .env nga server/ edhe nëse skripta xhirohet nga rrënja
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const [, , email, newpass] = process.argv;

if (!email || !newpass) {
    console.log('Usage: node tools/reset-pass.mjs <email> <newpass>');
    process.exit(1);
}

try {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is empty. Check server/.env");
    }
    const h = await hash(newpass);
    await q("UPDATE users SET password_hash=$1 WHERE email=$2", [h, email]);
    console.log("OK: password updated for", email);
    process.exit(0);
} catch (e) {
    console.error("RESET_PASS_ERR:", e.message);
    process.exit(1);
}
