"use strict";

/*
 * BANAT-ONLY MESSENGER BOT
 * ------------------------
 * No AI. No games. No economy. No RPG. No music. No database.
 *
 * ACTIVATION:
 *   Send: !banat on
 *
 * OTHER COMMANDS:
 *   !banat off
 *   !banat toggle
 *   !banat status
 *   !banat help
 *
 * After "!banat on", Banat stays active for that thread until "!banat off".
 * BANAT_DEFAULT_ON=true can be used to start every thread in active mode.
 */

const fs = require("fs");
const path = require("path");
const { login } = require("ws3-fca");
const { getBanatConversationReply } = require("./triggers");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { isDuplicateMessage } = require("./message-dedupe");
const { getGroupSettings, updateGroup: updateGroupSettings, getReactionSettings, isQuietNow, shouldReact } = require("./bot-settings");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");

const PORT = Number(process.env.PORT || 10000);
const DEFAULT_ON = /^(1|true|yes|on)$/i.test(process.env.BANAT_DEFAULT_ON || "false");
const GLOBAL_SEND_LIMIT = Math.max(1, Number(process.env.BANAT_GLOBAL_SEND_LIMIT || 2));
const THREAD_COOLDOWN_MS = Math.max(0, Number(process.env.BANAT_THREAD_COOLDOWN_MS ?? 2500));
const RETRY_DELAYS = [1500, 4000, 8000];

const activeThreads = new Set();
const threadQueues = new Map();
const threadLastSent = new Map();
const threadCooldown = new Map();
let globalActive = 0;
let botUserID = "";
let messengerApi = null;
let botPaused = false;
let messengerConnected = false;
let loginError = null;
let lastConnectedAt = null;
let lastDisconnectedAt = null;
let lastListenerError = null;
let lastMessageAt = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readSession() {
  const raw = process.env.FB_COOKIES || process.env.FB_APPSTATE;

  if (raw) {
    const trimmed = String(raw).trim();

    // ws3-fca 2.0.1 accepts a cookie/header string.
    // If Render contains JSON appstate, parse it first and convert it below.
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return trimmed;
    }
  }

  for (const file of ["appstate.json", "cookies.json"]) {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  throw new Error(
    "No Facebook session found. Set FB_COOKIES/FB_APPSTATE or provide appstate.json locally."
  );
}

function normalizeSession(value) {
  // ws3-fca 2.0.1 expects the saved Facebook session as a cookie string,
  // not { appState: [...] }. Convert exported cookie/appstate JSON into
  // the header format that version accepts.
  if (typeof value === "string") {
    const cookie = value.trim();
    if (!cookie) throw new Error("Facebook cookie session is empty.");
    return cookie;
  }

  const entries =
    Array.isArray(value) ? value :
    Array.isArray(value?.appState) ? value.appState :
    Array.isArray(value?.cookies) ? value.cookies :
    null;

  if (!entries) {
    throw new Error(
      "Facebook session must be a cookie string or a JSON array of cookie/appState entries."
    );
  }

  const parts = entries
    .map(cookie => {
      const key = cookie?.key ?? cookie?.name;
      const val = cookie?.value;
      if (key == null || val == null) return null;
      return String(key).trim() + "=" + String(val);
    })
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Facebook session contains no valid cookie entries.");
  }

  return parts.join("; ");
}

function enqueue(threadID, job) {
  const key = String(threadID);
  const current = threadQueues.get(key) || Promise.resolve();
  const next = current.catch(() => {}).then(job).finally(() => {
    if (threadQueues.get(key) === next) threadQueues.delete(key);
  });
  threadQueues.set(key, next);
  return next;
}

async function acquireGlobalSlot() {
  while (globalActive >= GLOBAL_SEND_LIMIT) await sleep(150);
  globalActive++;
}

function releaseGlobalSlot() { globalActive = Math.max(0, globalActive - 1); }

function is1545012(error) {
  const text = JSON.stringify(error || "");
  return /1545012|temporarily unavailable|message could not be sent/i.test(text);
}

function trafficSendMessage(api, message, threadID, callback, replyToMessageID = null) {
  const key = String(threadID);
  return enqueue(key, async () => {
    const now = Date.now();
    const cooldownUntil = Number(threadCooldown.get(key) || 0);
    if (cooldownUntil > now) {
      const waitMs = cooldownUntil - now;
      console.log(`[BANAT] waiting ${waitMs}ms for thread cooldown in ${key}`);
      await sleep(waitMs);
      if (Number(threadCooldown.get(key) || 0) <= Date.now()) threadCooldown.delete(key);
    }

    const groupSettings = getGroupSettings(key);
    const sendCooldownMs = groupSettings.cooldownMs == null ? THREAD_COOLDOWN_MS : Math.max(0, Number(groupSettings.cooldownMs));
    const sinceLast = now - Number(threadLastSent.get(key) || 0);
    if (sinceLast < sendCooldownMs) {
      const waitMs = sendCooldownMs - sinceLast;
      console.log(`[BANAT] send queue waiting ${waitMs}ms in ${key}`);
      await sleep(waitMs);
    }

    await acquireGlobalSlot();
    try {
      let lastError = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const result = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (err, info) => {
              if (settled) return;
              settled = true;
              err ? reject(err) : resolve(info);
            };
            try {
              let returned;
              if (replyToMessageID) returned = api.sendMessage(message, threadID, done, replyToMessageID);
              else returned = api.sendMessage(message, threadID, done);
              if (returned && typeof returned.then === "function") returned.then(info => done(null, info)).catch(done);
            } catch (e) { reject(e); }
          });
          threadLastSent.set(key, Date.now());
          console.log(`[BANAT] send succeeded in ${key}`);
          callback(null, result);
          return;
        } catch (error) {
          lastError = error;
          if (!is1545012(error) || attempt >= RETRY_DELAYS.length) break;
          threadCooldown.set(key, Date.now() + Math.min(15000, RETRY_DELAYS[attempt]));
          await sleep(RETRY_DELAYS[attempt]);
          threadCooldown.delete(key);
        }
      }
      if (is1545012(lastError)) {
        const cooldownMs = 60 * 1000;
        threadCooldown.set(key, Date.now() + cooldownMs);
        console.error(`[BANAT] Messenger send repeatedly failed in ${key}; pausing sends for ${cooldownMs}ms`);
      } else {
        console.error(`[BANAT] send failed in ${key}:`, lastError?.message || lastError);
      }
      callback(lastError);
    } finally {
      releaseGlobalSlot();
    }
  });
}

function isBanatCommand(body) {
  return /^!banat(?:\s|$)/i.test(String(body || "").trim());
}

function commandSendMessage(api, message, threadID, replyToMessageID = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(info);
    };

    try {
      const returned = replyToMessageID
        ? api.sendMessage(message, threadID, done, replyToMessageID)
        : api.sendMessage(message, threadID, done);

      if (returned && typeof returned.then === "function") {
        returned.then(info => done(null, info)).catch(done);
      }
    } catch (error) {
      done(error);
    }
  });
}

function sendCommandReply(api, event, message) {
  const threadID = String(event.threadID);
  commandSendMessage(api, message, threadID, event.messageID || null)
    .then(() => console.log(`[BANAT] command reply sent: ${message}`))
    .catch(error => console.error("[BANAT] command reply failed:", error?.message || error));
}

function handleBanatCommand(api, event, body) {
  const threadID = String(event.threadID);
  const parts = String(body).trim().split(/\s+/);
  const sub = (parts[1] || "status").toLowerCase();

  if (sub === "on" || sub === "enable" || sub === "start") {
    updateGroupSettings(threadID, { banatMode: "on" });
    setBanatConversationMode(threadID, true, event.senderID);
    activeThreads.add(threadID);
    console.log(`[BANAT] activated thread ${threadID} by ${event.senderID || "unknown"}`);
    sendCommandReply(api, event, "banat is on. say whatever u want 😭");
    return true;
  }

  if (sub === "off" || sub === "disable" || sub === "stop") {
    updateGroupSettings(threadID, { banatMode: "off" });
    setBanatConversationMode(threadID, false);
    activeThreads.delete(threadID);
    console.log(`[BANAT] deactivated thread ${threadID}`);
    sendCommandReply(api, event, "banat off. peace 😭");
    return true;
  }

  if (sub === "toggle") {
    const currentSettings = getGroupSettings(threadID);
    const currentlyOn = currentSettings.banatMode === "on" ||
      (currentSettings.banatMode === "inherit" && (activeThreads.has(threadID) || isBanatConversationModeActive(threadID)));
    const next = !currentlyOn;
    updateGroupSettings(threadID, { banatMode: next ? "on" : "off" });
    setBanatConversationMode(threadID, next, event.senderID);
    if (next) activeThreads.add(threadID);
    else activeThreads.delete(threadID);
    console.log(`[BANAT] toggled thread ${threadID}: ${next ? "ON" : "OFF"}`);
    sendCommandReply(api, event, next ? "banat is on 😭" : "banat is off");
    return true;
  }

  if (sub === "status") {
    const on = activeThreads.has(threadID) || isBanatConversationModeActive(threadID);
    sendCommandReply(api, event, on ? "banat: ON 🟢" : "banat: OFF 🔴");
    return true;
  }

  if (sub === "help") {
    sendCommandReply(api, event, "!banat on · !banat off · !banat toggle · !banat status");
    return true;
  }

  sendCommandReply(api, event, "unknown banat command. use !banat help");
  return true;
}

async function sendBanat(api, event, text) {
  const group = getGroupSettings(String(event.threadID));
  return sendBanatReplyWithTyping(api, text, String(event.threadID), event.messageID || null, {
    trafficSendMessage, incomingText: event.body || "",
    typingEnabled: group.typingEnabled,
    replyDelayMs: group.replyDelayMs === null ? undefined : group.replyDelayMs
  });
}
function reactToMessage(api,event,emoji) {
  const threadID=String(event?.threadID||""), messageID=String(event?.messageID||"");
  if(!threadID||!messageID)return;
  try {
    if(typeof api?.setMessageReactionMqtt==="function") api.setMessageReactionMqtt(emoji,messageID,threadID,()=>{});
    else if(typeof api?.setMessageReaction==="function") api.setMessageReaction(emoji,messageID,()=>{},true);
  } catch(error) { console.warn("[REACTION] Could not react:",error?.message||error); }
}

function onMessage(api, event) {
  if (!event) return;
  if (event.type && !["message", "message_reply"].includes(event.type)) return;
  if (botPaused) return;
  if (isDuplicateMessage(event.messageID)) {
    console.log(`[BANAT] ignored duplicate message event ${event.messageID}`);
    return;
  }
  if (event.senderID && botUserID && String(event.senderID) === String(botUserID)) return;

  const body = String(event.body || "").trim();
  if (!body) return;
  if (isBanatCommand(body)) { handleBanatCommand(api, event, body); return; }

  const threadID = String(event.threadID);
  const groupSettings = getGroupSettings(threadID);
  if (isQuietNow(groupSettings)) return;
  if (groupSettings.banatMode === "off") return;
  if (shouldReact(threadID, "incoming_messages")) reactToMessage(api, event, getReactionSettings().emoji);
  const active = groupSettings.banatMode === "on" || (groupSettings.banatMode === "inherit" && (activeThreads.has(threadID) || isBanatConversationModeActive(threadID)));
  const target = classifyBanatTarget({ event, body, eclipseUserID: botUserID });

  if (active) {
    console.log(`[BANAT] active message in ${threadID} from ${event.senderID || "unknown"}; generating reply`);
    const reply = getBanatConversationReply(body, threadID);
    if (reply) {
      sendBanat(api, event, reply).then(sent => { if (sent === false) console.warn(`[BANAT] reply was not delivered in ${threadID}`); }).catch(error => console.error("[BANAT] reply error:", error));
    } else {
      console.warn(`[BANAT] no reply generated for active message in ${threadID}; trigger and fallback both returned empty`);
    }
    return;
  }

  if (target.shouldRespond) {
    const reply = getTriggerReply(body, threadID) || getBanatConversationReply(body, threadID);
    if (reply) sendBanat(api, event, reply).catch(error => console.error("[BANAT]", error));
  }
}

function start(api) {
  messengerApi = api;
  messengerConnected = true;
  loginError = null;
  lastConnectedAt = new Date().toISOString();
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}

  if (DEFAULT_ON) console.log("[BANAT] BANAT_DEFAULT_ON enabled.");

  api.listenMqtt((error, event) => {
    if (error) {
      messengerConnected = false;
      lastDisconnectedAt = new Date().toISOString();
      lastListenerError = String(error?.message || error);
      console.error("[BANAT] listener error:", error);
      return;
    }
    if (event) {
      if (!messengerConnected) lastConnectedAt = new Date().toISOString();
      messengerConnected = true;
      lastListenerError = null;
      lastMessageAt = new Date().toISOString();
    }
    try {
      if (DEFAULT_ON && event?.threadID && event?.senderID && String(event.senderID) !== botUserID) {
        const key = String(event.threadID);
        if (!activeThreads.has(key)) {
          activeThreads.add(key);
          setBanatConversationMode(key, true, event.senderID);
        }
      }
      onMessage(api, event);
    } catch (e) {
      console.error("[BANAT] message handler error:", e);
    }
  });

  console.log(`[BANAT] online${botUserID ? ` as ${botUserID}` : ""}`);
}

function fetchMessengerGroups(api) {
  if(!api||typeof api.getThreadList!=="function") return Promise.reject(new Error("Messenger group list is unavailable from this session"));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const done=(err,list)=>{if(settled)return;settled=true;if(err)return reject(err);
      resolve((Array.isArray(list)?list:[]).filter(x=>x&&(x.threadID||x.threadId)).map(x=>({threadID:String(x.threadID||x.threadId),name:String(x.name||x.threadName||x.snippet||"Unnamed group"),isGroup:x.isGroup!==false,participantCount:Number(x.participantIDs?.length||x.participants?.length||0)})).filter(x=>x.isGroup));};
    try {const r=api.getThreadList(100,null,[],done);if(r&&typeof r.then==="function")r.then(v=>done(null,v)).catch(done);}catch(e){done(e);}
  });
}

function loginBot() {
  const cookie = normalizeSession(readSession());
  console.log("[BANAT] logging in with saved Facebook session...");
  console.log(`[BANAT] session format: cookie string (${cookie.length} chars)`);
  login(cookie, (error, api) => {
    if (error) {
      messengerConnected = false;
      loginError = String(error?.message || error);
      console.error("[BANAT] login failed:", error);
      process.exitCode = 1;
      return;
    }
    start(api);
  });
}

try {
  require("./dashboard-api")(PORT, () => ({
    ok: true,
    facebook_connected: messengerConnected,
    facebook_user_name: null,
    session_active: messengerConnected,
    bot_running: messengerConnected && !botPaused,
    login_in_progress: false,
    login_error: loginError,
    last_connected_at: lastConnectedAt,
    last_disconnected_at: lastDisconnectedAt,
    last_listener_error: lastListenerError,
    last_message_at: lastMessageAt,
    updated_at: new Date().toISOString()
  }), {
    setPaused: (paused) => { botPaused = paused; },
    getPaused: () => botPaused,
    getGroups: () => fetchMessengerGroups(messengerApi),
    getSettings: () => require("./bot-settings").getSettings(),
    updateReaction: input => require("./bot-settings").updateReaction(input),
    updateGroup: (threadID,input) => require("./bot-settings").updateGroup(threadID,input)
  });
} catch (error) {
  console.error("[BANAT] dashboard API failed:", error);
}

loginBot();

module.exports = { trafficSendMessage, onMessage, handleBanatCommand };
