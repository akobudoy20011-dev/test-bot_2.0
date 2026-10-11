"use strict";

/**
 * Typing-indicator lifecycle for the Banat human-delay pipeline.
 * The duration comes from human-delay.js, so visual typing and simulated
 * typing cadence stay in sync. Indicator failures never block sending.
 */

const ENABLED = !/^(false|0|no|off)$/i.test(String(process.env.TYPING_ENABLED || "true"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startTyping(api, threadID) {
  if (!api || !threadID) return false;
  try {
    if (typeof api.sendTypingIndicator === "function") {
      api.sendTypingIndicator(String(threadID), error => {
        if (error) console.warn("[HUMAN-TYPING] Start failed:", error?.message || error);
      });
      return true;
    }
    if (typeof api.sendTyping === "function") {
      api.sendTyping(String(threadID), true);
      return true;
    }
  } catch (error) {
    console.warn("[HUMAN-TYPING] Start failed:", error?.message || error);
  }
  return false;
}

function stopTyping(api, threadID) {
  if (!api || !threadID) return false;
  try {
    if (typeof api.sendTyping === "function") {
      api.sendTyping(String(threadID), false);
      return true;
    }
  } catch (error) {
    console.warn("[HUMAN-TYPING] Stop failed:", error?.message || error);
  }
  return false;
}

/**
 * opts.skip = true bypasses both the indicator and typing wait for rapid replies.
 * TYPING_ENABLED=false disables only the visual indicator; the human delay remains.
 * opts.ms should be prepared.typingMs from human-delay.js.
 */
async function typeBeforeSend(api, threadID, message, opts = {}, send) {
  if (typeof send !== "function") return false;
  if (opts.skip) return send();

  const duration = Math.max(0, Number(opts.ms) || 0);
  if (!duration) return send();

  if (ENABLED) startTyping(api, threadID);
  try {
    let remaining = duration;
    while (remaining > 0) {
      const slice = Math.min(4000, remaining);
      await sleep(slice);
      remaining -= slice;
      if (ENABLED && remaining > 0) {
        stopTyping(api, threadID);
        startTyping(api, threadID);
      }
    }
    return await send();
  } finally {
    if (ENABLED) stopTyping(api, threadID);
  }
}

module.exports = { typeBeforeSend, startTyping, stopTyping };
