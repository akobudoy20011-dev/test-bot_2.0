"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Fixed storage location; mount Render's persistent disk at the app's data/ directory.
const sessionPath = path.resolve(process.cwd(), "data", "dashboard-session.enc");
const MAX_SESSION_BYTES = 120 * 1024;

function key() {
  const secret = String(process.env.ECLIPSE_SESSION_ENCRYPTION_KEY || "");
  if (Buffer.byteLength(secret) < 32) throw new Error("Set ECLIPSE_SESSION_ENCRYPTION_KEY to a secret of at least 32 bytes before using dashboard cookie storage.");
  return crypto.createHash("sha256").update(secret).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") }) + "\n";
}
function decrypt(raw) {
  const record = JSON.parse(raw);
  if (record.version !== 1) throw new Error("Unsupported encrypted session format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
}

function normalizeSessionInput(value) {
  if (typeof value !== "string") throw new Error("Paste a cookie string or a JSON appstate export.");
  const input = value.trim();
  if (!input || Buffer.byteLength(input, "utf8") > MAX_SESSION_BYTES) {
    throw new Error("Paste a valid session (maximum 120 KB).");
  }

  // Accept common browser-export formats and store only the normalized cookie header.
  if (input.startsWith("[") || input.startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(input); }
    catch (_) { throw new Error("The JSON appstate is invalid. Paste the complete cookie array or appstate object."); }

    const entries = Array.isArray(parsed) ? parsed :
      Array.isArray(parsed?.appState) ? parsed.appState :
      Array.isArray(parsed?.cookies) ? parsed.cookies : null;
    if (!entries) throw new Error("JSON must be a cookie array or an object containing an appState or cookies array.");

    const parts = entries.map(cookie => {
      const name = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (name == null || val == null) return null;
      const safeName = String(name).trim();
      if (!safeName || /[=;\s]/.test(safeName) || /[\r\n;]/.test(String(val))) return null;
      return safeName + "=" + String(val);
    }).filter(Boolean);

    if (!parts.length) throw new Error("The appstate contains no valid cookie entries with name/key and value.");
    const normalized = parts.join("; ");
    if (Buffer.byteLength(normalized, "utf8") > MAX_SESSION_BYTES) throw new Error("Normalized cookie session exceeds 120 KB.");
    return normalized;
  }

  if (/[\r\n]/.test(input)) throw new Error("Cookie-header format must be a single line. For multiline exports, paste the complete JSON appstate instead.");
  if (!/(?:^|;\s*)c_user=[^;]+/i.test(input)) throw new Error("Cookie string must include a c_user cookie. Alternatively, paste the complete JSON appstate export.");
  return input;
}

function save(value) {
  const cookie = normalizeSessionInput(value);
  const dir = path.dirname(sessionPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = sessionPath + ".tmp";
  fs.writeFileSync(temp, encrypt(cookie), { mode: 0o600 });
  fs.renameSync(temp, sessionPath);
  try { fs.chmodSync(sessionPath, 0o600); } catch (_) {}
  return { saved: true };
}
function read() {
  if (!fs.existsSync(sessionPath)) return null;
  return decrypt(fs.readFileSync(sessionPath, "utf8"));
}
function status() {
  return { configured: fs.existsSync(sessionPath), storage: "encrypted" };
}
function clear() {
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  return { configured: false };
}
module.exports = { save, read, status, clear, normalizeSessionInput };
