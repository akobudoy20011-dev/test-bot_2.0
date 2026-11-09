"use strict";

function createGroupTitleGuard(options = {}) {
  const store = options.store;
  const getApi = options.getApi || (() => null);
  const cooldownMs = Math.max(30000, Number(options.cooldownMs) || 120000);
  const lastRepair = new Map();
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

  async function repair(threadID, reason = "event") {
    if (stopped || inFlight.has(threadID)) return { skipped: true };
    const now = Date.now();
    if (now - Number(lastRepair.get(threadID) || 0) < cooldownMs) return { skipped: true, cooldown: true };
    const config = await store.getGroup(threadID);
    if (!config.autolockEnabled || !config.expectedTitle) return { skipped: true };
    const api = getApi();
    if (!api) return { skipped: true, offline: true };
    inFlight.add(threadID);
    try {
      const info = await invoke(api, "getThreadInfo", [String(threadID)]);
      const actual = String(info?.threadName || info?.name || "").trim();
      if (actual === config.expectedTitle) return { ok: true, unchanged: true };
      lastRepair.set(threadID, now);
      await invoke(api, "setTitle", [config.expectedTitle, String(threadID)]);
      console.info("[GROUP TITLE LOCK] Restored group title", { thread_id: threadID, reason });
      return { ok: true, restored: true };
    } finally {
      inFlight.delete(threadID);
    }
  }

  async function handleEvent(event) {
    if (!event?.threadID) return;
    const type = [event.type, event.logMessageType, event.logMessageData?.type].filter(Boolean).join(" ").toLowerCase();
    if (type && !/(thread.?name|title|group.?name)/i.test(type)) return;
    try { await repair(String(event.threadID), "group-title-event"); }
    catch (error) { console.warn("[GROUP TITLE LOCK] Event repair failed:", error?.message || error); }
  }

  async function reconcile() {
    if (stopped || !store?.isInitialized?.()) return;
    try {
      const groups = await store.listProtectedGroups();
      for (const group of groups) {
        try { await repair(String(group.threadID), "periodic-reconcile"); }
        catch (error) { console.warn("[GROUP TITLE LOCK] Reconcile failed:", error?.message || error); }
      }
    } catch (error) {
      console.warn("[GROUP TITLE LOCK] Could not load protected groups:", error?.message || error);
    }
  }

  function start() {
    if (stopped || timer) return;
    void reconcile();
    timer = setInterval(() => void reconcile(), 10 * 60 * 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function pause() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    inFlight.clear();
  }

  return { start, pause, stop, handleEvent, repair };
}

module.exports = { createGroupTitleGuard };
