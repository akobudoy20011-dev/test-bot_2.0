"use strict";

const fs = require("fs");
const path = require("path");

const settingsPath = process.env.BOT_SETTINGS_PATH
  ? path.resolve(process.env.BOT_SETTINGS_PATH)
  : path.join(__dirname, "bot-settings.json");

const DEFAULTS = Object.freeze({
  reaction: { enabled: true, emoji: "😆", target: "bot_replies", probability: 100, cooldownSeconds: 0 },
  groups: {}
});
const reactionCooldowns = new Map();
let settings = load();

function load() {
  try {
    if (!fs.existsSync(settingsPath)) return { reaction: { ...DEFAULTS.reaction }, groups: {} };
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      reaction: sanitizeReaction(parsed?.reaction),
      groups: sanitizeGroups(parsed?.groups)
    };
  } catch (error) {
    console.warn("[SETTINGS] Could not load settings; using defaults:", error?.message || error);
    return { reaction: { ...DEFAULTS.reaction }, groups: {} };
  }
}

function sanitizeReaction(input = {}) {
  const target = ["bot_replies", "incoming_messages", "both"].includes(input.target) ? input.target : DEFAULTS.reaction.target;
  const emoji = String(input.emoji ?? DEFAULTS.reaction.emoji).trim().slice(0, 16) || DEFAULTS.reaction.emoji;
  return {
    enabled: input.enabled !== false,
    emoji,
    target,
    probability: clamp(input.probability, 0, 100, DEFAULTS.reaction.probability),
    cooldownSeconds: clamp(input.cooldownSeconds, 0, 86400, DEFAULTS.reaction.cooldownSeconds)
  };
}

function sanitizeGroups(input = {}) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [rawID, value] of Object.entries(input).slice(0, 500)) {
    const id = String(rawID).trim().slice(0, 128);
    if (!id || !value || typeof value !== "object") continue;
    result[id] = sanitizeGroup(value);
  }
  return result;
}

function sanitizeGroup(input = {}) {
  const mode = ["inherit", "on", "off"].includes(input.banatMode) ? input.banatMode : "inherit";
  const quietStart = validTime(input.quietStart) ? input.quietStart : "";
  const quietEnd = validTime(input.quietEnd) ? input.quietEnd : "";
  return {
    banatMode: mode,
    typingEnabled: input.typingEnabled !== false,
    replyDelayMs: clamp(input.replyDelayMs, 0, 30000, 0),
    cooldownMs: input.cooldownMs === null || input.cooldownMs === "" || input.cooldownMs === undefined
      ? null : clamp(input.cooldownMs, 0, 300000, 0),
    quietStart,
    quietEnd
  };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function validTime(value) { return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }

function persist() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    return true;
  } catch (error) {
    console.error("[SETTINGS] Could not save settings:", error?.message || error);
    return false;
  }
}

function getSettings() {
  return JSON.parse(JSON.stringify(settings));
}
function getReactionSettings() { return { ...settings.reaction }; }
function getGroupSettings(threadID) {
  return { ...sanitizeGroup(settings.groups[String(threadID)] || {}) };
}
function updateReaction(input) {
  settings.reaction = sanitizeReaction({ ...settings.reaction, ...(input || {}) });
  if (!persist()) throw new Error("Settings could not be saved to disk.");
  return getReactionSettings();
}
function updateGroup(threadID, input) {
  const id = String(threadID || "").trim();
  if (!id || id.length > 128) throw new Error("A valid group thread ID is required.");
  settings.groups[id] = sanitizeGroup({ ...settings.groups[id], ...(input || {}) });
  if (!persist()) throw new Error("Settings could not be saved to disk.");
  return { threadID: id, ...getGroupSettings(id) };
}
function removeGroup(threadID) {
  delete settings.groups[String(threadID)];
  if (!persist()) throw new Error("Settings could not be saved to disk.");
  return true;
}

function isQuietNow(group, now = new Date()) {
  if (!group?.quietStart || !group?.quietEnd || group.quietStart === group.quietEnd) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(now).split(":").map(Number);
  const current = parts[0] * 60 + parts[1];
  const [sh, sm] = group.quietStart.split(":").map(Number);
  const [eh, em] = group.quietEnd.split(":").map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function shouldReact(threadID, target) {
  const config = settings.reaction;
  if (!config.enabled) return false;
  if (config.target !== "both" && config.target !== target) return false;
  const key = String(threadID);
  const now = Date.now();
  const cooldownMs = config.cooldownSeconds * 1000;
  if (cooldownMs && now - Number(reactionCooldowns.get(key) || 0) < cooldownMs) return false;
  if (Math.random() * 100 >= config.probability) return false;
  reactionCooldowns.set(key, now);
  return true;
}

module.exports = {
  getSettings, getReactionSettings, getGroupSettings, updateReaction, updateGroup,
  removeGroup, isQuietNow, shouldReact, settingsPath
};
