import fs from "fs";

export function readEnvOrFile(name, { required = false, trim = true } = {}) {
  const direct = process.env[name];
  const filePath = process.env[`${name}_FILE`];

  let v = direct;
  if ((!v || v === "") && filePath) {
    try {
      v = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      if (required) throw new Error(`Failed to read ${name}_FILE: ${filePath}`);
      v = "";
    }
  }

  if (trim && typeof v === "string") v = v.trim();
  if (required && (!v || v === "")) throw new Error(`Missing required secret: ${name}`);
  return v || "";
}
