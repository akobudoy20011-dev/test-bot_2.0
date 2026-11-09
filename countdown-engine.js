"use strict";

const DEFAULT_REASON = "DI TUMAGOS SA COUNTDOWN CHALLENGE 😭";
const wait = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === "function") timer.unref();
});

function createCountdownEngine(options = {}) {
  const store = options.store;
  const getApi = options.getApi || (() => null);
  const states = new Map();
  let stopped = false;
  let suspended = false;

  function clearTimer(state) {
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = null;
  }

  function valid(state, generation) {
    return !stopped && !suspended && state && state.generation === generation &&
      states.get(state.threadID) === state;
  }

  async function persist(state, status) {
    if (!store?.isInitialized?.()) return;
    try {
      await store.saveCountdownState({
        threadID: state.threadID, targetId: state.targetId, targetName: state.targetName,
        lockedAt: state.lockedAt, lastActivityAt: state.lastActivityAt,
        countdownStartedAt: state.countdownStartedAt, nextNumber: state.nextNumber,
        status: status || (state.counting ? "counting" : "waiting")
      });
    } catch (error) {
      console.warn("[COUNTDOWN] Could not persist state:", error?.message || error);
    }
  }

  async function send(api, threadID, message, guard) {
    if (!api || typeof api.sendMessage !== "function") return false;
    if (guard && !guard()) return false;
    return new Promise(resolve => {
      let settled = false;
      const done = error => {
        if (settled) return;
        settled = true;
        resolve(!error);
      };
      try {
        const result = api.sendMessage(String(message), String(threadID), done);
        if (result && typeof result.then === "function") result.then(() => done(null)).catch(done);
      } catch (_) { done(new Error("Messenger send failed")); }
    });
  }

  function schedule(threadID, state, generation) {
    clearTimer(state);
    const elapsed = Math.max(0, Date.now() - Number(state.lastActivityAt || Date.now()));
    const remaining = Math.max(0, Number(state.inactivityMs || 300000) - elapsed);
    state.timer = setTimeout(() => {
      state.timer = null;
      void run(threadID, state, generation);
    }, remaining);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  async function selectedTargetStillValid(threadID, state) {
    try {
      const group = await store.getGroup(threadID);
      return group.countdownEnabled && String(group.countdownTargetId || "") === state.targetId;
    } catch (error) {
      console.warn("[COUNTDOWN] Could not verify selected target:", error?.message || error);
      return false;
    }
  }

  async function run(threadID, state, generation) {
    if (!valid(state, generation) || state.counting) return;
    state.counting = true;
    state.countdownStartedAt = Number(state.countdownStartedAt) || Date.now();
    await persist(state, "counting");
    const api = state.api || getApi();
    for (let number = Math.max(1, Number(state.nextNumber) || 1); number <= 100; number++) {
      if (!valid(state, generation)) return;
      if ((number === 1 || number % 5 === 0) && !(await selectedTargetStillValid(threadID, state))) {
        if (valid(state, generation)) {
          clearTimer(state);
          states.delete(threadID);
          await store.deleteCountdownState(threadID).catch(() => {});
        }
        return;
      }
      state.nextNumber = number + 1;
      await persist(state, "counting");
      const sent = await send(api, threadID, String(number), () => valid(state, generation));
      if (!sent) {
        if (valid(state, generation)) {
          state.counting = false;
          state.nextNumber = number;
          state.lastActivityAt = Date.now();
          await persist(state, "send_failed");
        }
        return;
      }
      if (number < 100) {
        await wait(Number(state.countDelayMs) || 2000);
        if (!valid(state, generation)) return;
      }
    }
    if (!valid(state, generation)) return;
    const endedAt = Date.now();
    const targetName = state.targetName || "UNKNOWN TARGET";
    const fmt = ts => new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
    }).format(new Date(ts));
    const resultMessage = [
      "WIN: HEV",
      "LOSE: " + targetName.toLocaleUpperCase("en-US"),
      "REASON: " + DEFAULT_REASON,
      "START: " + fmt(state.countdownStartedAt),
      "END: " + fmt(endedAt)
    ].join("\n");
    const posted = await send(api, threadID, resultMessage, () => valid(state, generation));
    if (!valid(state, generation)) return;
    if (!posted) {
      state.counting = false;
      state.lastActivityAt = Date.now();
      await persist(state, "send_failed");
      return;
    }
    try {
      await store.recordCountdownResult({
        threadID, targetId: state.targetId, targetName, result: "WIN",
        startedAt: state.countdownStartedAt, endedAt, reason: DEFAULT_REASON
      });
      await store.deleteCountdownState(threadID);
    } catch (error) {
      console.warn("[COUNTDOWN] Could not save completed run:", error?.message || error);
    }
    clearTimer(state);
    states.delete(threadID);
  }

  async function onMessage(api, event) {
    if (stopped || !event?.threadID || !event?.senderID || event.type && !["message", "message_reply"].includes(event.type)) return;
    const threadID = String(event.threadID);
    const senderID = String(event.senderID);
    let state = states.get(threadID);

    // Invalidate a running count immediately when its selected target returns.
    if (state && senderID === state.targetId && state.counting) {
      const generation = state.generation;
      state.generation++;
      clearTimer(state);
      state.counting = false;
      states.delete(threadID);
      const endedAt = Date.now();
      try {
        await store.recordCountdownResult({
          threadID, targetId: state.targetId, targetName: state.targetName,
          result: "LOSE", startedAt: state.countdownStartedAt || state.lastActivityAt,
          endedAt, reason: "TARGET_RETURNED"
        });
        await store.deleteCountdownState(threadID);
      } catch (error) {
        console.warn("[COUNTDOWN] Could not record target return:", error?.message || error);
      }
      state = null;
    }

    let group;
    try { group = await store.getGroup(threadID); }
    catch (error) { console.warn("[COUNTDOWN] Could not load group config:", error?.message || error); return; }
    const targetId = String(group.countdownTargetId || "");
    if (!group.countdownEnabled || !targetId) {
      if (state) {
        state.generation++;
        clearTimer(state);
        states.delete(threadID);
        await store.deleteCountdownState(threadID).catch(() => {});
      }
      return;
    }

    if (state && state.targetId !== targetId) {
      state.generation++;
      clearTimer(state);
      states.delete(threadID);
      await store.deleteCountdownState(threadID).catch(() => {});
      state = null;
    }
    if (senderID !== targetId) return;

    const now = Date.now();
    if (!state) {
      state = {
        threadID, targetId, targetName: String(group.countdownTargetName || ""),
        lockedAt: now, lastActivityAt: now, countdownStartedAt: null, nextNumber: 1,
        inactivityMs: Number(group.inactivityMs) || 300000, countDelayMs: Number(group.countDelayMs) || 2000,
        timer: null, generation: 0, counting: false, api
      };
      states.set(threadID, state);
    } else {
      state.targetName = String(group.countdownTargetName || state.targetName || "");
      state.inactivityMs = Number(group.inactivityMs) || 300000;
      state.countDelayMs = Number(group.countDelayMs) || 2000;
      state.api = api;
      state.countdownStartedAt = null;
      state.nextNumber = 1;
      state.counting = false;
    }
    state.lastActivityAt = now;
    state.generation++;
    await persist(state, "waiting");
    schedule(threadID, state, state.generation);
  }

  async function restore(api = getApi()) {
    if (stopped || !store?.isInitialized?.() || !api) return;
    suspended = false;
    let saved = [];
    try { saved = await store.loadCountdownStates(); }
    catch (error) { console.warn("[COUNTDOWN] Could not restore saved runs:", error?.message || error); return; }
    for (const item of saved) {
      const threadID = String(item.threadID || "");
      const targetId = String(item.targetId || "");
      if (!threadID || !targetId || states.has(threadID)) continue;
      let group;
      try { group = await store.getGroup(threadID); } catch (_) { continue; }
      if (!group.countdownEnabled || String(group.countdownTargetId || "") !== targetId) {
        await store.deleteCountdownState(threadID).catch(() => {});
        continue;
      }
      const state = {
        threadID, targetId, targetName: String(item.targetName || group.countdownTargetName || ""),
        lockedAt: Number(item.lockedAt) || Date.now(), lastActivityAt: Number(item.lastActivityAt) || Date.now(),
        countdownStartedAt: item.countdownStartedAt == null ? null : Number(item.countdownStartedAt),
        nextNumber: Math.max(1, Number(item.nextNumber) || 1),
        inactivityMs: Number(group.inactivityMs) || 300000, countDelayMs: Number(group.countDelayMs) || 2000,
        timer: null, generation: 0, counting: false, api
      };
      states.set(threadID, state);
      if (item.status === "counting" && state.countdownStartedAt) {
        void run(threadID, state, state.generation);
      } else {
        schedule(threadID, state, state.generation);
      }
    }
  }

  function pause() {
    suspended = true;
    for (const state of states.values()) { state.generation++; clearTimer(state); }
    states.clear();
  }

  async function cancel(threadID) {
    const id = String(threadID || "");
    const state = states.get(id);
    if (state) {
      state.generation++;
      clearTimer(state);
      states.delete(id);
    }
    if (store?.isInitialized?.()) await store.deleteCountdownState(id).catch(() => {});
    return Boolean(state);
  }

  function stop() {
    stopped = true;
    for (const state of states.values()) {
      state.generation++;
      clearTimer(state);
    }
    states.clear();
  }

  return { onMessage, restore, cancel, pause, stop, getActive: () => [...states.values()].map(s => ({
    threadID: s.threadID, targetId: s.targetId, targetName: s.targetName,
    counting: s.counting, nextNumber: s.nextNumber, lastActivityAt: s.lastActivityAt
  })) };
}

module.exports = { createCountdownEngine };
