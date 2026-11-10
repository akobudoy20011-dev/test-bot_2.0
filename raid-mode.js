"use strict";
const crypto = require("crypto");
const { Readable } = require("stream");
const { Pool } = require("pg");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const encodePath = value => String(value).split("/").map(encodeURIComponent).join("/");

function invoke(api, method, args) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api[method] !== "function") return reject(new Error("Messenger API method " + method + " is unavailable."));
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(result);
    };
    try {
      const returned = api[method](...args, done);
      if (returned && typeof returned.then === "function") returned.then(value => done(null, value)).catch(done);
    } catch (error) { done(error); }
  });
}

// ws3-fca@2.0.1 signature: changeNickname(nickname, threadID, participantID, callback).
function changeNickname(api, nickname, threadID, participantID) {
  return invoke(api, "changeNickname", [nickname, String(threadID), String(participantID)]);
}

function setRaidTitle(api, title, threadID) {
  return invoke(api, "setTitle", [title, String(threadID)]);
}

function changeRaidGroupImage(api, image, threadID) {
  return invoke(api, "changeGroupImage", [image, String(threadID)]);
}

function isRaidMutationEvent(event) {
  if (!event || !event.threadID) return false;
  const type = [event.type, event.logMessageType, event.logMessageData?.type]
    .filter(Boolean).join(" ").toLowerCase();
  return /(thread.?name|thread.?image|user.?nickname|nickname|subscribe|unsubscribe|participant|admin)/i.test(type);
}

function createRaidMode(options = {}) {
  const env = options.env || process.env;
  const namespace = String(options.namespace || env.ECLIPSE_RAID_BOT_NAMESPACE || "test-bot").slice(0, 64);
  const themeId = String(env.ECLIPSE_RAID_THEME_ID || "shared").slice(0, 64);
  const databaseUrl = env.ECLIPSE_RAID_DATABASE_URL || env.ECLIPSE_LICENSE_DATABASE_URL || env.DATABASE_URL || "";
  const pool = databaseUrl ? new Pool({
    connectionString: databaseUrl, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
    ssl: /sslmode=require/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined
  }) : null;
  const imageStore = options.imageStore || null;
  const apiGetter = options.getApi || (() => null);
  const inFlight = new Map();
  const eventRepairCooldown = new Map();
  const repairLogCooldown = new Map();
  let initialized = false, initError = "", reconcileTimer = null, lastEventAt = null, stopGeneration = 0;

  async function initialize() {
    if (!pool) { initError = "Raid Mode needs the existing Neon database connection (ECLIPSE_LICENSE_DATABASE_URL or DATABASE_URL)."; return false; }
    try {
      await pool.query([
        "CREATE TABLE IF NOT EXISTS eclipse_raid_themes (theme_id TEXT PRIMARY KEY, theme JSONB NOT NULL, image_bytes BYTEA, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "ALTER TABLE eclipse_raid_themes ADD COLUMN IF NOT EXISTS image_bytes BYTEA",
        "CREATE TABLE IF NOT EXISTS eclipse_raid_groups (bot_namespace TEXT NOT NULL, thread_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'off', last_sync TIMESTAMPTZ, last_image_sync TIMESTAMPTZ, last_error TEXT, failures INTEGER NOT NULL DEFAULT 0, next_retry_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (bot_namespace,thread_id))",
        "ALTER TABLE eclipse_raid_groups ADD COLUMN IF NOT EXISTS last_image_sync TIMESTAMPTZ",
        "CREATE INDEX IF NOT EXISTS eclipse_raid_groups_enabled_idx ON eclipse_raid_groups (bot_namespace,enabled)",
        "CREATE TABLE IF NOT EXISTS eclipse_raid_events (id BIGSERIAL PRIMARY KEY, bot_namespace TEXT NOT NULL, thread_id TEXT, event_type TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        "CREATE INDEX IF NOT EXISTS eclipse_raid_events_recent_idx ON eclipse_raid_events (bot_namespace,created_at DESC)"
      ].join(";"));
      initialized = true; initError = ""; return true;
    } catch (error) {
      initError = String(error?.message || error).slice(0, 300);
      console.error("[RAID] Neon initialization failed:", initError);
      return false;
    }
  }

  async function record(type, threadID = null, details = {}) {
    if (!initialized) return;
    try {
      await pool.query("INSERT INTO eclipse_raid_events (bot_namespace,thread_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)",
        [namespace, threadID == null ? null : String(threadID), type, JSON.stringify(details)]);
    } catch (error) { console.warn("[RAID] Could not persist event:", error?.message || error); }
  }

  async function getTheme() {
    if (!initialized) return null;
    const result = await pool.query("SELECT theme FROM eclipse_raid_themes WHERE theme_id=$1", [themeId]);
    return result.rows[0]?.theme || null;
  }

  async function writeTheme(theme) {
    await pool.query(
      "INSERT INTO eclipse_raid_themes (theme_id,theme,updated_at) VALUES ($1,$2::jsonb,NOW()) ON CONFLICT (theme_id) DO UPDATE SET theme=EXCLUDED.theme,updated_at=NOW()",
      [themeId, JSON.stringify(theme)]);
  }

  async function saveTheme(input = {}) {
    if (!initialized) throw new Error(initError || "Raid Mode storage is unavailable.");
    const groupTitle = String(input.groupTitle || "").trim().slice(0, 100);
    const nickname = String(input.nickname || "").trim().slice(0, 64);
    if (!groupTitle) throw new Error("Enter a group chat name for the Raid theme.");
    if (!nickname) throw new Error("Enter the nickname to apply to every member.");
    const current = await getTheme();
    const theme = {
      groupTitle, nickname, imageKey: null,
      imageType: current?.imageType || null, imageName: current?.imageName || null,
      updatedAt: new Date().toISOString()
    };
    await writeTheme(theme);
    await record("theme-saved", null, { groupTitle, hasImage: Boolean(theme.imageType) });
    return theme;
  }

  async function uploadImage(buffer, contentType, fileName = "raid-theme") {
    if (!initialized) throw new Error(initError || "Raid Mode storage is unavailable.");
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    const type = String(contentType || "").toLowerCase();
    if (!allowed.has(type)) throw new Error("Use a PNG, JPEG, or WebP image.");
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error("Image must be between 1 byte and 5 MB.");
    // Verify the file signature instead of trusting the browser-supplied MIME type.
    const valid = type === "image/png" ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : type === "image/jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid) throw new Error("The uploaded file does not match its image type.");
    const current = await getTheme() || { groupTitle: "", nickname: "" };
    const theme = { ...current, imageKey: null, imageType: type, imageName: String(fileName || "raid-theme").slice(0, 120), updatedAt: new Date().toISOString() };
    await pool.query(
      "INSERT INTO eclipse_raid_themes (theme_id,theme,image_bytes,updated_at) VALUES ($1,$2::jsonb,$3,NOW()) ON CONFLICT (theme_id) DO UPDATE SET theme=EXCLUDED.theme,image_bytes=EXCLUDED.image_bytes,updated_at=NOW()",
      [themeId, JSON.stringify(theme), buffer]
    );
    await record("theme-image-uploaded", null, { contentType: type, bytes: buffer.length });
    return { imageName: theme.imageName, imageType: type, updatedAt: theme.updatedAt };
  }
  async function getImage() {
    if (!initialized) return null;
    const result = await pool.query("SELECT image_bytes, theme->>'imageType' AS image_type FROM eclipse_raid_themes WHERE theme_id=$1", [themeId]);
    const row = result.rows[0];
    if (!row?.image_bytes) return null;
    return { buffer: Buffer.from(row.image_bytes), contentType: row.image_type || "image/png" };
  }

  async function getGroups() {
    if (!initialized) return [];
    const result = await pool.query("SELECT thread_id,enabled,status,last_sync,last_error,failures,next_retry_at FROM eclipse_raid_groups WHERE bot_namespace=$1 ORDER BY updated_at DESC", [namespace]);
    return result.rows.map(row => ({
      threadID: row.thread_id, enabled: row.enabled, status: row.status,
      lastSync: row.last_sync, lastError: row.last_error, failures: row.failures, nextRetryAt: row.next_retry_at
    }));
  }

  async function getStatus() {
    const theme = await getTheme().catch(() => null);
    const groups = await getGroups().catch(() => []);
    return {
      available: Boolean(initialized), ready: Boolean(initialized),
      active: groups.some(group => group.enabled), namespace,
      theme: theme ? { groupTitle: theme.groupTitle, nickname: theme.nickname, imageName: theme.imageName, hasImage: Boolean(theme.imageType), updatedAt: theme.updatedAt } : null,
      groups, imageStorageConfigured: Boolean(initialized),
      storage: "neon", error: initError || null,
      lastEventAt
    };
  }

  async function setGroupState(threadID, state, error = null, failures = 0, retryAt = null) {
    await pool.query(
      "UPDATE eclipse_raid_groups SET status=$3,last_error=$4,failures=$5,next_retry_at=$6,last_sync=CASE WHEN $3='active' THEN NOW() ELSE last_sync END,updated_at=NOW() WHERE bot_namespace=$1 AND thread_id=$2",
      [namespace, String(threadID), state, error ? String(error).slice(0, 300) : null, failures, retryAt]);
  }

  async function applyOnce(threadID, reason, generation) {
    const api = apiGetter();
    if (!api) throw new Error("Messenger is disconnected; Raid Mode repair is waiting for reconnection.");
    const stillEnabled = async () => {
      if (generation !== stopGeneration) throw new Error("Raid Mode was stopped during repair.");
      const state = await pool.query("SELECT enabled FROM eclipse_raid_groups WHERE bot_namespace=$1 AND thread_id=$2", [namespace, String(threadID)]);
      if (!state.rows[0]?.enabled) throw new Error("Raid Mode is no longer active for this group.");
    };
    await stillEnabled();
    const theme = await getTheme();
    if (!theme?.groupTitle || !theme?.nickname || !theme?.imageType) throw new Error("Complete the Raid theme and upload its group photo before activation.");
    const info = await invoke(api, "getThreadInfo", [String(threadID)]);
    if (!info) throw new Error("Messenger returned no group information for this thread.");
    if (info.isGroup === false || Number(info.threadType) === 1) throw new Error("Raid Mode can only be activated for group chats.");
    const currentTitle = String(info?.threadName || info?.name || "");
    if (currentTitle !== theme.groupTitle) {
      await setRaidTitle(api, theme.groupTitle, threadID);
      await stillEnabled();
    }
    const participantSource = Array.isArray(info.participantIDs) ? info.participantIDs : Array.isArray(info.participants) ? info.participants.map(person => person?.id || person?.userID || person?.userId) : Object.keys(info.userInfo || {});
    const participantIDs = [...new Set(participantSource.map(String).filter(Boolean))];
    for (const participantID of participantIDs) {
      const currentNickname = String(info?.nicknames?.[participantID] || info?.participantNicknames?.[participantID] || "");
      if (currentNickname !== theme.nickname) {
        await stillEnabled();
        await changeNickname(api, theme.nickname, threadID, participantID);
        await sleep(250);
      }
    }
    const imageState = await pool.query("SELECT last_image_sync FROM eclipse_raid_groups WHERE bot_namespace=$1 AND thread_id=$2", [namespace, String(threadID)]);
    const lastImageSync = imageState.rows[0]?.last_image_sync ? new Date(imageState.rows[0].last_image_sync).getTime() : 0;
    const forceImage = reason === "activation" || reason === "manual-repair" || /thread.?image/i.test(reason) || Date.now() - lastImageSync >= 30 * 60_000;
    if (forceImage) {
      await stillEnabled();
      const image = await getImage();
      if (!image?.buffer) throw new Error("Raid Mode group photo is missing from Neon. Upload it again.");
      await changeRaidGroupImage(api, Readable.from([image.buffer]), threadID);
      await pool.query("UPDATE eclipse_raid_groups SET last_image_sync=NOW() WHERE bot_namespace=$1 AND thread_id=$2", [namespace, String(threadID)]);
    }
    return { participants: participantIDs.length };
  }

  async function repairGroup(threadID, reason = "manual-repair") {
    const id = String(threadID || "").trim();
    if (!initialized || !id) throw new Error("Raid Mode storage or group ID is unavailable.");
    if (inFlight.has(id)) return inFlight.get(id);
    const task = (async () => {
      const generation = stopGeneration;
      const current = await pool.query("SELECT enabled,failures,next_retry_at FROM eclipse_raid_groups WHERE bot_namespace=$1 AND thread_id=$2", [namespace, id]);
      if (!current.rows[0]?.enabled) throw new Error("Raid Mode is not active for this group.");
      const retryAt = current.rows[0].next_retry_at ? new Date(current.rows[0].next_retry_at).getTime() : 0;
      if (retryAt > Date.now() && reason !== "manual-repair") return { skipped: true, retryAt };
      await setGroupState(id, "syncing", null, Number(current.rows[0].failures || 0));
      try {
        const result = await applyOnce(id, reason, generation);
        await setGroupState(id, "active", null, 0, null);
        await record("group-repaired", id, { reason, participants: result.participants });
        return result;
      } catch (error) {
        const message = String(error?.message || error);
        const failures = Number(current.rows[0].failures || 0) + 1;
        const transientConnection = /EPIPE|EHOSTUNREACH|ECONNRESET|ECONNREFUSED|socket hang up|Messenger is disconnected/i.test(message);
        const rateLimited = /rate.?limit|1675004|1545012|temporarily unavailable/i.test(message);
        const delay = (rateLimited || transientConnection) ? 5 * 60_000 : Math.min(15 * 60_000, 15000 * (2 ** Math.min(failures - 1, 5)));
        const next = new Date(Date.now() + delay).toISOString();
        await setGroupState(id, "error", message, failures, next);
        await record("group-repair-failed", id, { reason, error: message, failures, retryAt: next });
        throw error;
      }
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, task);
    return task;
  }

  async function activate(input = {}) {
    if (!initialized) throw new Error(initError || "Raid Mode storage is unavailable.");
    const theme = await getTheme();
    if (!theme?.groupTitle || !theme?.nickname || !theme?.imageType) throw new Error("Save a complete theme and upload its photo before activating Raid Mode.");
    const ids = [...new Set((Array.isArray(input.threadIDs) ? input.threadIDs : []).map(x => String(x).trim()).filter(Boolean))].slice(0, 50);
    if (!ids.length) throw new Error("Select at least one Messenger group.");
    for (const id of ids) {
      await pool.query(
        "INSERT INTO eclipse_raid_groups (bot_namespace,thread_id,enabled,status,failures,next_retry_at,last_error,updated_at) VALUES ($1,$2,TRUE,'pending',0,NULL,NULL,NOW()) ON CONFLICT (bot_namespace,thread_id) DO UPDATE SET enabled=TRUE,status='pending',failures=0,next_retry_at=NULL,last_error=NULL,updated_at=NOW()",
        [namespace, id]);
    }
    await record("raid-activated", null, { groups: ids.length });
    const results = [];
    for (const id of ids) {
      try { await repairGroup(id, "activation"); results.push({ threadID: id, ok: true, error: null }); }
      catch (error) { results.push({ threadID: id, ok: false, error: String(error?.message || error) }); }
      await sleep(1200);
    }
    return { activated: ids.length, results };
  }

  async function emergencyStop() {
    stopGeneration += 1;
    if (!initialized) throw new Error(initError || "Raid Mode storage is unavailable.");
    const result = await pool.query("UPDATE eclipse_raid_groups SET enabled=FALSE,status='stopped',next_retry_at=NULL,updated_at=NOW() WHERE bot_namespace=$1 AND enabled=TRUE RETURNING thread_id", [namespace]);
    await record("emergency-stop", null, { groups: result.rowCount });
    return { stopped: result.rowCount };
  }

  function logRepairFailureOnce(threadID, kind, error) {
    const id = String(threadID);
    const key = kind + ":" + id;
    const now = Date.now();
    const previous = repairLogCooldown.get(key) || 0;
    if (now - previous < 60_000) return;
    repairLogCooldown.set(key, now);
    if (repairLogCooldown.size > 500) {
      for (const [entry, at] of repairLogCooldown) if (now - at > 10 * 60_000) repairLogCooldown.delete(entry);
    }
    console.warn("[RAID] " + kind + " failed for " + id + ":", error?.message || error);
  }

  async function handleEvent(event) {
    if (!initialized || !isRaidMutationEvent(event)) return;
    const type = [event.type, event.logMessageType, event.logMessageData?.type].filter(Boolean).join(" ").toLowerCase();
    const id = String(event.threadID);
    const found = await pool.query("SELECT enabled FROM eclipse_raid_groups WHERE bot_namespace=$1 AND thread_id=$2", [namespace, id]).catch(() => ({ rows: [] }));
    if (!found.rows[0]?.enabled) return;
    const now = Date.now();
    const lastRepair = eventRepairCooldown.get(id) || 0;
    if (now - lastRepair < 30_000) return;
    eventRepairCooldown.set(id, now);
    if (eventRepairCooldown.size > 500) {
      for (const [entry, at] of eventRepairCooldown) if (now - at > 10 * 60_000) eventRepairCooldown.delete(entry);
    }
    lastEventAt = new Date().toISOString();
    await record("mutation-detected", id, { type });
    repairGroup(id, "event:" + type).catch(error => logRepairFailureOnce(id, "event repair", error));
  }

  async function reconcile() {
    if (!initialized) return;
    const result = await pool.query("SELECT thread_id FROM eclipse_raid_groups WHERE bot_namespace=$1 AND enabled=TRUE ORDER BY updated_at ASC", [namespace]);
    for (const row of result.rows) {
      repairGroup(row.thread_id, "periodic-reconcile").catch(error => logRepairFailureOnce(row.thread_id, "reconciliation", error));
      await sleep(1500);
    }
  }

  function start() {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(() => reconcile().catch(error => console.warn("[RAID] reconciliation loop failed:", error?.message || error)), 10 * 60_000);
    reconcileTimer.unref?.();
    reconcile().catch(error => console.warn("[RAID] initial reconciliation failed:", error?.message || error));
  }
  function stop() { if (reconcileTimer) clearInterval(reconcileTimer); reconcileTimer = null; }

  return {
    initialize, start, stop, activate, emergencyStop, repairGroup, handleEvent,
    saveTheme, uploadImage, getImage, getStatus, getGroups,
    close: async () => { stop(); if (pool) await pool.end(); },
    isInitialized: () => initialized
  };
}
module.exports = { createRaidMode, changeNickname, setRaidTitle, changeRaidGroupImage, isRaidMutationEvent };
