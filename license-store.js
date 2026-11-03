"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const truthy = value => /^(1|true|yes|on)$/i.test(String(value || ""));

function createLicenseStore() {
  const dataDir = path.resolve(process.env.ECLIPSE_SECURITY_DATA_DIR || path.join(process.cwd(), ".eclipse-security"));
  const identityPath = path.resolve(process.env.ECLIPSE_INSTALLATION_ID_FILE || path.join(dataDir, "installation-id"));
  const registryPath = path.resolve(process.env.ECLIPSE_LICENSE_REGISTRY_PATH || path.join(dataDir, "registry.json"));
  const databaseUrl = process.env.ECLIPSE_LICENSE_DATABASE_URL || process.env.DATABASE_URL || "";
  const allowFileStore = truthy(process.env.ECLIPSE_LICENSE_ALLOW_FILE_STORE);
  const configuredInstallationId = String(process.env.ECLIPSE_INSTALLATION_ID || "").trim();
  let pool = null;
  let ownerInstallationId = "";
  let mode = "client";
  let initialized = false;

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  async function initialize(ownerMode) {
    mode = ownerMode ? "owner" : "client";
    if (!ownerMode || initialized) return;
    if (databaseUrl) {
      if (!pool) pool = new Pool({
        connectionString: databaseUrl,
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        ssl: /sslmode=require/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined
      });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS eclipse_license_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eclipse_license_installations (
          installation_id TEXT PRIMARY KEY,
          data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS eclipse_license_events (
          event_id TEXT PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL,
          event_type TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS eclipse_license_events_at_idx
          ON eclipse_license_events (at DESC);
      `);
      const existing = await pool.query("SELECT value FROM eclipse_license_meta WHERE key = 'owner_installation_id'");
      if (existing.rows[0]) {
        ownerInstallationId = existing.rows[0].value;
      } else {
        const candidate = crypto.randomUUID();
        await pool.query(
          "INSERT INTO eclipse_license_meta (key, value) VALUES ('owner_installation_id', $1) ON CONFLICT (key) DO NOTHING",
          [candidate]
        );
        const saved = await pool.query("SELECT value FROM eclipse_license_meta WHERE key = 'owner_installation_id'");
        ownerInstallationId = saved.rows[0].value;
      }
      initialized = true;
      return;
    }
    if (!allowFileStore) {
      throw new Error("ECLIPSE_LICENSE_DATABASE_URL (Neon PostgreSQL) is required for the owner service. File storage is disabled unless ECLIPSE_LICENSE_ALLOW_FILE_STORE=true is explicitly set for local development/tests.");
    }
    ensureDir();
    try {
      ownerInstallationId = fs.readFileSync(identityPath, "utf8").trim();
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    if (!/^[a-f0-9-]{32,64}$/i.test(ownerInstallationId)) {
      ownerInstallationId = crypto.randomUUID();
      fs.writeFileSync(identityPath, ownerInstallationId + "\n", { mode: 0o600 });
    }
    initialized = true;
  }

  function getInstallationId() {
    if (mode === "owner") {
      if (!ownerInstallationId) throw new Error("License store has not finished initializing.");
      return ownerInstallationId;
    }
    ensureDir();
    if (configuredInstallationId) {
      if (!/^[a-f0-9-]{32,64}$/i.test(configuredInstallationId)) {
        throw new Error("ECLIPSE_INSTALLATION_ID must be a UUID or 32-64 character hexadecimal/hyphen installation ID.");
      }
      // Explicit configuration takes precedence over ephemeral filesystem identity.
      // Persist it locally as a fallback if the environment variable is later removed.
      fs.writeFileSync(identityPath, configuredInstallationId + "\n", { mode: 0o600, flag: "w" });
      return configuredInstallationId;
    }
    let id = "";
    try { id = fs.readFileSync(identityPath, "utf8").trim(); }
    catch (error) { if (!error || error.code !== "ENOENT") throw error; }
    if (!/^[a-f0-9-]{32,64}$/i.test(id)) {
      id = crypto.randomUUID();
      fs.writeFileSync(identityPath, id + "\n", { mode: 0o600, flag: "w" });
    }
    return id;
  }

  async function readRegistry() {
    if (pool) {
      const [installations, events, settings] = await Promise.all([
        pool.query("SELECT installation_id, data FROM eclipse_license_installations"),
        pool.query("SELECT event_id, at, event_type, details FROM eclipse_license_events ORDER BY at DESC LIMIT 500"),
        pool.query("SELECT value FROM eclipse_license_meta WHERE key = 'license_settings'")
      ]);
      const mapped = {};
      for (const row of installations.rows) mapped[row.installation_id] = row.data;
      return {
        installations: mapped,
        events: events.rows.map(row => ({
          id: row.event_id,
          at: new Date(row.at).toISOString(),
          type: row.event_type,
          ...(row.details || {})
        })),
        settings: settings.rows[0] ? JSON.parse(settings.rows[0].value) : { max_approved_installations: 0 }
      };
    }
    ensureDir();
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      return {
        installations: parsed && parsed.installations && typeof parsed.installations === "object" ? parsed.installations : {},
        events: Array.isArray(parsed && parsed.events) ? parsed.events.slice(0, 500) : [],
        settings: parsed && parsed.settings && typeof parsed.settings === "object" ? parsed.settings : { max_approved_installations: 0 }
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
      return { installations: {}, events: [], settings: { max_approved_installations: 0 } };
    }
  }

  async function writeRegistry(registry) {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const [id, entry] of Object.entries(registry.installations || {})) {
          await client.query(
            "INSERT INTO eclipse_license_installations (installation_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (installation_id) DO UPDATE SET data = EXCLUDED.data",
            [id, JSON.stringify(entry)]
          );
        }
        if (registry.settings) {
          await client.query(
            "INSERT INTO eclipse_license_meta (key, value) VALUES ('license_settings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [JSON.stringify(registry.settings)]
          );
        }
        for (const event of (registry.events || []).slice(0, 500)) {
          const details = { ...event };
          delete details.id;
          delete details.at;
          delete details.type;
          await client.query(
            "INSERT INTO eclipse_license_events (event_id, at, event_type, details) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (event_id) DO NOTHING",
            [event.id || crypto.randomUUID(), event.at, event.type, JSON.stringify(details)]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return;
    }
    ensureDir();
    const temporary = registryPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, registryPath);
  }

  async function close() {
    if (pool) {
      await pool.end();
      pool = null;
    }
  }

  return { initialize, getInstallationId, readRegistry, writeRegistry, close };
}

module.exports = { createLicenseStore };
