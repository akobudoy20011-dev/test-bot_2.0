"use strict";

function validateReactionTarget(settings = {}) {
  if (settings.targetMode === "member") {
    if (!String(settings.targetThreadID || "").trim() || !String(settings.targetUserId || "").trim()) {
      throw new Error("Choose a Messenger group and a custom reaction target.");
    }
  }
  return settings;
}

function createReactionAudience(options = {}) {
  const getAdmins = options.getAdmins || (async () => []);
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 120000);
  const now = options.now || Date.now;
  const cache = new Map();

  async function adminsFor(api, threadID) {
    const key = String(threadID || "");
    if (!key) return [];
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.promise;
    const promise = Promise.resolve(getAdmins(api, key))
      .then(ids => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))])
      .catch(error => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, { promise, expiresAt: now() + ttlMs });
    return promise;
  }

  async function isAllowed(settings = {}, event = {}, api) {
    const mode = ["all", "admins", "member"].includes(settings.targetMode) ? settings.targetMode : "admins";
    const threadID = String(event.threadID || "");
    const senderID = String(event.senderID || "");
    if (!threadID || !senderID) return false;
    if (mode === "all") return true;
    if (mode === "member") {
      return Boolean(settings.targetUserId && settings.targetThreadID &&
        String(settings.targetThreadID) === threadID &&
        String(settings.targetUserId) === senderID);
    }
    if (settings.targetThreadID && String(settings.targetThreadID) !== threadID) return false;
    try {
      const ids = await adminsFor(api, threadID);
      return ids.includes(senderID);
    } catch (_) {
      return false;
    }
  }

  function invalidate(threadID) {
    if (threadID == null) cache.clear();
    else cache.delete(String(threadID));
  }

  return { isAllowed, invalidate };
}

module.exports = { createReactionAudience, validateReactionTarget };
