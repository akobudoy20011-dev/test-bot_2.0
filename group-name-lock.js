"use strict";

const { getSettings } = require("./bot-settings");

const inFlight = new Set();

function eventNameChange(event = {}) {
  const candidates = [
    event.logMessageType,
    event.type,
    event.logMessageData?.logMessageType,
    event.logMessageData?.type,
    event.logMessageData?.eventType
  ].filter(Boolean).map(value => String(value).toLowerCase());
  return candidates.some(value => /thread[-_: ]?name|name[-_: ]?change|change[-_: ]?thread/.test(value));
}

function eventThreadID(event = {}) {
  const value = event.threadID ?? event.threadId ?? event.logMessageData?.threadID ?? event.logMessageData?.threadId;
  return value == null ? "" : String(value);
}

function eventTitle(event = {}) {
  const data = event.logMessageData || {};
  const value = data.name ?? data.threadName ?? data.newName ?? data.title ?? event.threadName ?? event.newName;
  return value == null ? "" : String(value).trim();
}

function getThreadInfo(api, threadID) {
  if (typeof api?.getThreadInfo !== "function") return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const done = (error, info) => {
      if (settled) return;
      settled = true;
      resolve(error ? null : (info || null));
    };
    try {
      const returned = api.getThreadInfo(String(threadID), done);
      if (returned && typeof returned.then === "function") returned.then(info => done(null, info)).catch(() => done(new Error("getThreadInfo failed")));
    } catch (_) {
      done(new Error("getThreadInfo failed"));
    }
  });
}

function infoTitle(info) {
  const value = info?.threadName ?? info?.name ?? info?.title;
  return value == null ? "" : String(value).trim();
}

async function restoreIfNeeded(api, threadID, group, setGroupTitle, observedTitle = "") {
  const desired = String(group?.lockedThreadName || "").trim().slice(0, 80);
  if (!group?.autoLockNameEnabled || !desired || !threadID || inFlight.has(threadID)) return false;

  let actual = String(observedTitle || "").trim();
  if (!actual) {
    const info = await getThreadInfo(api, threadID);
    actual = infoTitle(info);
    // If the library cannot tell us the current title, do not issue a blind rename
    // on every event; the event handler below can still use a known changed title.
    if (!actual) return false;
  }
  if (actual === desired) return false;

  inFlight.add(threadID);
  try {
    await setGroupTitle(api, threadID, desired);
    console.log(`[NAME-LOCK] Restored group name in ${threadID}.`);
    return true;
  } catch (error) {
    console.error(`[NAME-LOCK] Could not restore group name in ${threadID}:`, error?.message || error);
    return false;
  } finally {
    inFlight.delete(threadID);
  }
}

async function handleThreadNameChange(api, event, setGroupTitle) {
  if (!event || !eventNameChange(event)) return false;
  const threadID = eventThreadID(event);
  if (!threadID) return false;
  const group = getSettings().groups?.[threadID];
  if (!group?.autoLockNameEnabled || !group.lockedThreadName) return false;

  const changedTitle = eventTitle(event);
  if (changedTitle && changedTitle === group.lockedThreadName) return false;
  return restoreIfNeeded(api, threadID, group, setGroupTitle, changedTitle);
}

async function reconcileLockedGroupNames(api, setGroupTitle) {
  if (typeof api?.getThreadInfo !== "function") return;
  const groups = getSettings().groups || {};
  for (const [threadID, group] of Object.entries(groups)) {
    if (!group?.autoLockNameEnabled || !group.lockedThreadName || inFlight.has(threadID)) continue;
    await restoreIfNeeded(api, threadID, group, setGroupTitle);
  }
}

module.exports = { handleThreadNameChange, reconcileLockedGroupNames, eventNameChange, eventThreadID, eventTitle };
