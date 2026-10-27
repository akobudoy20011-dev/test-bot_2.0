"use strict";

// Ported from mess-bot/typingIndicator.js. ws3-fca v2+ expects
// sendTypingIndicator(active, threadID, callback), not (threadID, callback).
const ENABLED = !/^(false|0|no|off)$/i.test(String(process.env.TYPING_ENABLED || "true"));
const activeStates = new WeakMap();
const REFRESH_MS = 25000;

function getThreadStates(api) {
  let states = activeStates.get(api);
  if (!states) {
    states = new Map();
    activeStates.set(api, states);
  }
  return states;
}

function requestTyping(api, active, threadID) {
  const key = String(threadID);
  try {
    if (typeof api.sendTypingIndicator === "function") {
      let callbackReported = false;
      const callback = (error) => {
        callbackReported = true;
        if (error) console.warn("[HUMAN-TYPING] Indicator callback error:", error?.message || error);
      };
      const result = api.sendTypingIndicator(Boolean(active), key, callback);
      if (result && typeof result.then === "function") {
        result.then(() => {
          if (!callbackReported) console.log("[HUMAN-TYPING] Indicator promise resolved (" + (active ? "ON" : "OFF") + ") for " + key);
        }).catch(error => console.warn("[HUMAN-TYPING] Indicator promise rejected:", error?.message || error));
      }
      return true;
    }
    if (typeof api.sendTyping === "function") {
      api.sendTyping(key, Boolean(active));
      return true;
    }
    console.warn("[HUMAN-TYPING] No supported typing-indicator API for thread " + key);
  } catch (error) {
    console.warn("[HUMAN-TYPING] Indicator request failed:", error?.message || error);
  }
  return false;
}

function startTyping(api, threadID) {
  if (!ENABLED || !api || !threadID) return false;
  const key = String(threadID);
  try {
    const states = getThreadStates(api);
    const existing = states.get(key);
    if (existing && !existing.stopped) return true;

    const state = { timer: null, stopped: false };
    states.set(key, state);
    if (!requestTyping(api, true, key)) {
      states.delete(key);
      return false;
    }

    const refresh = () => {
      if (state.stopped || states.get(key) !== state) return;
      requestTyping(api, true, key);
      state.timer = setTimeout(refresh, REFRESH_MS);
      if (typeof state.timer?.unref === "function") state.timer.unref();
    };
    state.timer = setTimeout(refresh, REFRESH_MS);
    if (typeof state.timer?.unref === "function") state.timer.unref();
    return true;
  } catch (error) {
    console.warn("[HUMAN-TYPING] Unable to start indicator:", error?.message || error);
    return false;
  }
}

function stopTyping(api, threadID) {
  if (!api || !threadID) return false;
  const key = String(threadID);
  try {
    const states = activeStates.get(api);
    const state = states?.get(key);
    if (state) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      states.delete(key);
      return requestTyping(api, false, key);
    }
    if (typeof api.sendTyping === "function" && typeof api.sendTypingIndicator !== "function") {
      return requestTyping(api, false, key);
    }
    return false;
  } catch (error) {
    console.warn("[HUMAN-TYPING] Unable to stop indicator:", error?.message || error);
    return false;
  }
}

function withTyping(api, threadID, durationMs, send) {
  if (typeof send !== "function") return Promise.resolve(false);
  const duration = Math.max(0, Number(durationMs) || 0);
  startTyping(api, threadID);
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        resolve(await send());
      } catch (error) {
        reject(error);
      } finally {
        stopTyping(api, threadID);
      }
    }, duration);
  });
}

module.exports = { startTyping, stopTyping, withTyping };
