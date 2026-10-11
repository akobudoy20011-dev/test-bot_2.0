"use strict";

/**
 * Typing-indicator lifecycle for the Banat human-delay pipeline.
 *
 * The caller supplies the duration calculated by human-delay.js, so the
 * indicator timing matches the same humanization profile as the reply.
 * Typing API failures are cosmetic and must never block the actual message.
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
 * Wait for the delay engine's typingMs while the indicator is active, then
 * send. The indicator remains active until the send callback/promise settles.
 *
 * opts.skip = true bypasses the indicator and wait (for rapid replies).
 * opts.ms should be prepared.typingMs from human-delay.js.
 */
async function typeBeforeSend(api, threadID, message, opts = {}, send) {
  if (typeof send !== "function") return false;
  if (!ENABLED || opts.skip) return send();

  const duration = Math.max(0, Number(opts.ms) || 0);
  if (!duration) return send();

  startTyping(api, threadID);
  try {
    // Refresh long typing bubbles without changing the calculated total delay.
    let remaining = duration;
    while (remaining > 0) {
      const slice = Math.min(4000, remaining);
      await sleep(slice);
      remaining -= slice;
      if (remaining > 0) {
        stopTyping(api, threadID);
        startTyping(api, threadID);
      }
    }
    return await send();
  } finally {
    stopTyping(api, threadID);
  }
}

module.exports = { typeBeforeSend, startTyping, stopTyping };
