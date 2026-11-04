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
const { isBotAdmin } = require("./admin-access");
const { getGroupSettings, updateGroup: updateGroupSettings, getReactionSettings, isQuietNow, shouldReact } = require("./bot-settings");
const { classifyBanatTarget, setBanatConversationMode, isBanatConversationModeActive } = require("./banat-targeting");
const { createLicenseGuard } = require("./license-guard");
const { createRaidMode } = require("./raid-mode");
const licenseGuard = createLicenseGuard();
const raidMode = createRaidMode({ getApi: () => messengerApi, namespace: "test-bot" });
let licenseAuthorized = false;

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
let loginInProgress = false;
let loginGeneration = 0;
let activeListenerGeneration = 0;
let loginRetryTimer = null;
let loginAttempt = 0;
let queuedReplacementSession = null;
const MAX_LOGIN_BACKOFF_MS = 5 * 60_000;
const LISTENER_RETRY_MS = 30_000;
const RATE_LIMIT_RETRY_MS = 120_000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readSession() {
  const dashboardSession = require("./session-store").read();
  if (dashboardSession) return dashboardSession;
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
  const changesBotState = ["on", "enable", "start", "off", "disable", "stop", "toggle"].includes(sub);

  // State-changing commands are restricted to IDs explicitly configured in BOT_ADMIN_IDS.
  // With no configured admin IDs, nobody can remotely change the bot state.
  if (changesBotState && !isBotAdmin(event.senderID)) {
    sendCommandReply(api, event, "⛔ only configured bot admins can turn Banat on or off.");
    console.warn(`[BANAT] rejected state change from non-admin ${event.senderID || "unknown"} in ${threadID}`);
    return true;
  }

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
  if (botPaused || !licenseAuthorized) return;
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

function start(api, generation, sessionCandidate = null) {
  const previousApi = messengerApi;
  // A replacement becomes active only after login succeeds. Stop the old
  // listener immediately before promoting the validated API.
  if (previousApi && previousApi !== api) {
    activeListenerGeneration = 0;
    try { previousApi.stopListenMqtt?.(); }
    catch (error) { console.warn("[BANAT] previous listener stop failed:", error?.message || error); }
  }

  messengerApi = api;
  activeListenerGeneration = generation;
  messengerConnected = true;
  loginError = null;
  loginAttempt = 0;
  lastConnectedAt = new Date().toISOString();
  lastListenerError = null;
  try { botUserID = String(api.getCurrentUserID?.() || ""); } catch (_) {}

  // Keep the freshest session checkpoint in process memory. This remains
  // ephemeral on Render Free and never writes credentials to disk or logs.
  try {
    const refreshed = api.getAppState?.();
    if (Array.isArray(refreshed) && refreshed.length) {
      require("./session-store").save(JSON.stringify(refreshed));
    } else if (sessionCandidate) {
      require("./session-store").save(sessionCandidate);
    }
  } catch (error) {
    console.warn("[AUTH] Could not refresh in-memory session checkpoint:", error?.message || error);
  }

  if (DEFAULT_ON) console.log("[BANAT] BANAT_DEFAULT_ON enabled.");
  try {
    if (typeof api.setOptions === "function") api.setOptions({ listenEvents: true });
  } catch (error) { console.warn("[RAID] Could not enable Messenger group events:", error?.message || error); }
  if (licenseAuthorized && raidMode.isInitialized()) raidMode.start();

  api.listenMqtt((error, event) => {
    if (generation !== activeListenerGeneration) return;
    if (error) {
      messengerConnected = false;
      lastDisconnectedAt = new Date().toISOString();
      lastListenerError = getFacebookLoginErrorMessage(error);
      messengerApi = null;
      activeListenerGeneration = 0;
      try { api.stopListenMqtt?.(); }
      catch (stopError) { console.warn("[BANAT] failed listener cleanup:", stopError?.message || stopError); }
      console.error("[BANAT] listener error:", lastListenerError);

      if (isExplicitSessionRejection(lastListenerError)) {
        loginError = "Facebook rejected the Messenger session. Paste a fresh session in the dashboard.";
        console.error("[AUTH] Session rejection detected; automatic login retries are paused.");
        return;
      }
      if (isUnverifiableSessionError(lastListenerError)) {
        loginError = "Messenger could not verify the session (user ID lookup failed). Check the cookie export and Facebook login state, then submit a fresh session. Automatic retries are paused.";
        console.error("[AUTH] Session verification is ambiguous; automatic retries are paused for manual review.");
        return;
      }
      const delay = /1675004|rate.?limit|too many requests/i.test(lastListenerError)
        ? RATE_LIMIT_RETRY_MS : LISTENER_RETRY_MS;
      scheduleLoginRetry(delay, "listener recovery");
      return;
    }
    if (event) {
      if (!messengerConnected) lastConnectedAt = new Date().toISOString();
      messengerConnected = true;
      lastListenerError = null;
      lastMessageAt = new Date().toISOString();
    }
    try {
      if (licenseAuthorized && event) raidMode.handleEvent(event).catch(error => console.warn("[RAID] event handler failed:", error?.message || error));
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

function getFacebookLoginErrorMessage(error) {
  const parts = [];
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (value == null || depth > 2) return;
    if (["string", "number", "boolean"].includes(typeof value)) {
      const part = String(value).trim();
      if (part && !parts.includes(part)) parts.push(part);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of ["name", "message", "errorDescription", "error_description", "description", "reason", "error", "code", "type"]) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(error);
  return (parts.join(" | ") || "Facebook login failed.")
    .replace(/(["']?(?:password|cookie|appstate|access[_-]?token|session(?:[_-]?id|[_-]?token)?)["']?\\s*[:=]\\s*)[^,;\\s}]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function isExplicitSessionRejection(value) {
  return /checkpoint|two.factor|2fa|invalid cookie|cookie.*(?:invalid|expired|rejected)|session.*(?:expired|invalid|rejected)|not logged in|login required|authentication failed|account disabled|confirm your identity/i.test(String(value || ""));
}

function isUnverifiableSessionError(value) {
  return /error retrieving user.?id|unable to retrieve user.?id|could not retrieve user.?id|no cookie or credentials found/i.test(String(value || ""));
}

function scheduleLoginRetry(delay, reason) {
  if (loginRetryTimer) return;
  const wait = Math.max(1000, Number(delay) || LISTENER_RETRY_MS);
  console.warn(`[LOGIN] ${reason}; retry scheduled in ${wait}ms.`);
  loginRetryTimer = setTimeout(() => {
    loginRetryTimer = null;
    if (licenseAuthorized && !messengerConnected && !loginInProgress) loginBot();
  }, wait);
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

function loginBot(sessionOverride = null) {
  if (!licenseAuthorized) {
    console.warn("[ECLIPSE LICENSE] Messenger login blocked because this installation is not authorized.");
    return false;
  }
  if (loginInProgress) {
    if (sessionOverride) {
      queuedReplacementSession = sessionOverride;
      console.warn("[LOGIN] Replacement session queued behind the current login attempt.");
      return true;
    }
    console.warn("[LOGIN] Login already in progress; duplicate attempt skipped.");
    return false;
  }
  if (messengerConnected && messengerApi && activeListenerGeneration > 0 && !sessionOverride) {
    console.warn("[LOGIN] Existing Messenger listener is healthy; duplicate login skipped.");
    return false;
  }

  let cookie;
  try {
    const supplied = sessionOverride || readSession();
    cookie = normalizeSession(require("./session-store").normalizeSessionInput(
      typeof supplied === "string" ? supplied : JSON.stringify(supplied)
    ));
  } catch (error) {
    loginError = getFacebookLoginErrorMessage(error);
    console.error("[AUTH] Session input is incomplete or invalid:", loginError);
    return false;
  }

  loginInProgress = true;
  const generation = ++loginGeneration;
  let settled = false;
  console.log("[BANAT] validating Messenger session (credential values are never logged).");

  const finishFailure = error => {
    if (settled || generation !== loginGeneration) return;
    settled = true;
    loginInProgress = false;
    loginError = getFacebookLoginErrorMessage(error);
    console.error("[AUTH] Messenger login failed:", loginError);

    if (queuedReplacementSession) {
      const queued = queuedReplacementSession;
      queuedReplacementSession = null;
      console.warn("[LOGIN] Starting the queued replacement session after the previous attempt settled.");
      loginBot(queued);
      return;
    }

    // A failed replacement must not displace a currently working API/listener.
    if (sessionOverride && messengerConnected && messengerApi) {
      loginError = "Replacement session was rejected; the existing Messenger connection remains active.";
      console.warn("[AUTH] Keeping the existing Messenger listener after replacement failure.");
      return;
    }
    if (isExplicitSessionRejection(loginError)) {
      loginError = "Facebook rejected the session. Paste a fresh cookie/appstate export in the dashboard.";
      console.error("[AUTH] Automatic retries paused because Facebook rejected the session.");
      return;
    }
    if (isUnverifiableSessionError(loginError)) {
      loginError = "Messenger could not verify the session (user ID lookup failed). Check the cookie export and Facebook login state, then submit a fresh session. Automatic retries are paused.";
      console.error("[AUTH] Session verification is ambiguous; automatic retries are paused for manual review.");
      return;
    }

    loginAttempt += 1;
    const delay = Math.min(2 ** loginAttempt * 1000, MAX_LOGIN_BACKOFF_MS);
    scheduleLoginRetry(delay, "transient login failure");
  };

  try {
    const result = login(cookie, (error, api) => {
      if (generation !== loginGeneration || settled) return;
      if (error || !api) return finishFailure(error || new Error("Login returned no Messenger API."));
      settled = true;
      loginInProgress = false;
      if (loginRetryTimer) {
        clearTimeout(loginRetryTimer);
        loginRetryTimer = null;
      }
      start(api, generation, sessionOverride);
      if (queuedReplacementSession) {
        const queued = queuedReplacementSession;
        queuedReplacementSession = null;
        setTimeout(() => loginBot(queued), 0);
      }
    });
    if (result && typeof result.then === "function") {
      result.then(api => {
        if (generation !== loginGeneration || settled || !api) return;
        settled = true;
        loginInProgress = false;
        if (loginRetryTimer) { clearTimeout(loginRetryTimer); loginRetryTimer = null; }
        start(api, generation, sessionOverride);
        if (queuedReplacementSession) {
          const queued = queuedReplacementSession;
          queuedReplacementSession = null;
          setTimeout(() => loginBot(queued), 0);
        }
      }).catch(finishFailure);
    }
  } catch (error) {
    finishFailure(error);
  }
  return true;
}

try {
  require("./dashboard-api")(PORT, () => ({
    ok: true,
    facebook_connected: messengerConnected,
    facebook_user_name: null,
    session_active: messengerConnected,
    bot_running: messengerConnected && !botPaused && licenseAuthorized,
    login_in_progress: loginInProgress,
    login_error: loginError,
    last_connected_at: lastConnectedAt,
    last_disconnected_at: lastDisconnectedAt,
    last_listener_error: lastListenerError,
    last_message_at: lastMessageAt,
    updated_at: new Date().toISOString(),
    license: { ...licenseGuard.getStatus(), authorized: licenseAuthorized }
  }), {
    setPaused: (paused) => { botPaused = paused; },
    getPaused: () => botPaused || !licenseAuthorized,
    saveSession: value => {
      const candidate = require("./session-store").normalizeSessionInput(value);
      loginBot(candidate);
      return { saved: true, validating: true, storage: "memory" };
    },
    getSessionStatus: () => require("./session-store").status(),
    clearSession: () => require("./session-store").clear(),
    getGroups: () => fetchMessengerGroups(messengerApi),
    getSettings: () => require("./bot-settings").getSettings(),
    updateReaction: input => require("./bot-settings").updateReaction(input),
    updateGroup: (threadID,input) => require("./bot-settings").updateGroup(threadID,input),
    raidMode,
    isLicensed: () => licenseAuthorized,
    licenseGuard
  });
} catch (error) {
  console.error("[BANAT] dashboard API failed:", error);
}

raidMode.initialize().then(ok => {
  if (ok && messengerConnected) raidMode.start();
  if (!ok) console.warn("[RAID] Raid Mode is unavailable until its Neon configuration is completed.");
}).catch(error => console.warn("[RAID] initialization failed:", error?.message || error));

licenseGuard.initialize().then(ok => {
  licenseAuthorized = ok;
  if (ok) {
    console.log("[ECLIPSE LICENSE] Installation authorized:", licenseGuard.getInstallationId());
    loginBot();
  } else {
    console.error("[ECLIPSE LICENSE] Bot processing is disabled:", licenseGuard.getStatus().last_error);
  }
  licenseGuard.startHeartbeat(reason => {
    licenseAuthorized = false;
    raidMode.stop();
    console.error("[ECLIPSE LICENSE] Authorization revoked; message processing disabled:", reason);
  }, () => {
    licenseAuthorized = true;
    if (raidMode.isInitialized()) raidMode.start();
    console.log("[ECLIPSE LICENSE] Installation authorization restored.");
    if (!messengerConnected && !loginInProgress) loginBot();
  });
}).catch(error => {
  licenseAuthorized = false;
  console.error("[ECLIPSE LICENSE] Authorization initialization failed; bot processing remains disabled:", error?.message || error);
});

module.exports = { trafficSendMessage, onMessage, handleBanatCommand };
