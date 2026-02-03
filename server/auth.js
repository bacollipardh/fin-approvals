import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { readEnvOrFile } from "./util/secrets.js";

dotenv.config();

const JWT_SECRET = readEnvOrFile("JWT_SECRET", { required: true });

export const signJWT = (user) =>
  jwt.sign(
    { id: user.id, role: user.role, division_id: user.division_id },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );

export const hash = (p) => bcrypt.hash(p, 10);
export const compare = (p, h) => bcrypt.compare(p, h);

export const requireAuth = (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  next();
};
