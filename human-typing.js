"use strict";

function startTyping(api, threadID) {
  try {
    if (typeof api?.sendTypingIndicator === "function") {
      api.sendTypingIndicator(threadID, () => {});
      return;
    }
    if (typeof api?.sendTypingIndicator === "function") api.sendTypingIndicator(threadID);
  } catch (_) {}
}

function stopTyping(api, threadID) {
  try {
    if (typeof api?.sendTypingIndicator === "function") {
      api.sendTypingIndicator(false, threadID, () => {});
    }
  } catch (_) {}
}

module.exports = { startTyping, stopTyping };
