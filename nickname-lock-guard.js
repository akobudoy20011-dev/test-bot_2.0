"use strict";

function createNicknameLockGuard(options = {}) {
  const store = options.store;
  const getApi = options.getApi || (() => null);
  const cooldownMs = Math.max(30000, Number(options.cooldownMs) || 120000);
  const lastRepair = new Map();
  const lastUserRepair = new Map();
  const inFlight = new Set();
  let timer = null;
  let stopped = false;

  function invoke(api, method, args) {
    return new Promise((resolve, reject) => {
      if (!api || typeof api[method] !== "function") return reject(new Error("Messenger API method " + method + " is unavailable."));
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve(value);
      };
      try {
        const returned = api[method](...args, done);
        if (returned && typeof returned.then === "function") returned.then(value => done(null, value)).catch(done);
      } catch (error) { done(error); }
    });
  }

  async function restoreGroup(threadID, reason = "reconcile", forcedUserID = "") {
    const id = String(threadID || "").trim();
    if (stopped || !id || inFlight.has(id)) return { skipped: true };
    const now = Date.now();
    if (now - Number(lastRepair.get(id) || 0) < cooldownMs && !forcedUserID) return { skipped: true, cooldown: true };
    if (forcedUserID && forcedUserID !== "*") {
      const key = id + ":" + String(forcedUserID);
      if (now - Number(lastUserRepair.get(key) || 0) < cooldownMs) return { skipped: true, cooldown: true };
    }
    const locks = await store.getNicknameLocks(id);
    if (!locks.length) return { skipped: true };
    const api = getApi();
    if (!api) return { skipped: true, offline: true };
    inFlight.add(id);
    try {
      const info = await invoke(api, "getThreadInfo", [id]);
      const participantIDs = Array.isArray(info?.participantIDs) ? new Set(info.participantIDs.map(String)) : null;
      const nicknames = info?.nicknames && typeof info.nicknames === "object" ? info.nicknames : null;
      const results = [];
      for (const lock of locks) {
        const userID = String(lock.userID);
        if (forcedUserID && forcedUserID !== "*" && userID !== String(forcedUserID)) continue;
        if (participantIDs && !participantIDs.has(userID)) {
          await store.deleteNicknameLock(id, userID);
          continue;
        }
        const current = nicknames ? String(nicknames[userID] || "") : null;
        if (current === String(lock.expectedNickname)) continue;
        const forceThisUser = forcedUserID === "*" || forcedUserID === userID;
        if (current === null && !forceThisUser) continue;
        await invoke(api, "changeNickname", [String(lock.expectedNickname), id, userID]);
        lastUserRepair.set(id + ":" + userID, now);
        results.push(userID);
      }
      if (results.length) {
        lastRepair.set(id, now);
        console.info("[NICKNAME LOCK] Restored protected nicknames", { thread_id: id, count: results.length, reason });
      }
      return { ok: true, restored: results.length };
    } finally {
      inFlight.delete(id);
    }
  }

  async function handleEvent(event) {
    if (!event?.threadID) return;
    const type = [event.type, event.logMessageType, event.logMessageData?.type].filter(Boolean).join(" ").toLowerCase();
    if (!/(nickname|thread-nickname)/i.test(type)) return;
    const data = event.logMessageData || {};
    const userID = String(data.participant_id || data.participantID || data.user_id || data.userID || "");
    try { await restoreGroup(String(event.threadID), "nickname-change-event", userID); }
    catch (error) { console.warn("[NICKNAME LOCK] Event repair failed:", error?.message || error); }
  }

  async function reconcile(reason = "periodic-reconcile") {
    if (stopped || !store?.isInitialized?.()) return;
    try {
      const locks = await store.listNicknameLocks();
      const groups = [...new Set(locks.map(item => String(item.threadID)).filter(Boolean))];
      const reconnect = reason === "reconnect";
      for (const id of groups) {
        try { await restoreGroup(id, reason, reconnect ? "*" : ""); }
        catch (error) { console.warn("[NICKNAME LOCK] Reconcile failed:", { thread_id: id, error: error?.message || error }); }
      }
    } catch (error) {
      console.warn("[NICKNAME LOCK] Could not load saved nickname locks:", error?.message || error);
    }
  }

  function start() {
    if (stopped) return;
    void reconcile("reconnect");
    if (timer) return;
    timer = setInterval(() => void reconcile(), 10 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function pause() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stop() {
    stopped = true;
    pause();
    inFlight.clear();
  }

  return { start, pause, stop, handleEvent, reconcile, restoreGroup };
}

module.exports = { createNicknameLockGuard };
