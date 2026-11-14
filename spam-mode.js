"use strict";

const MIN_INTERVAL_SECONDS = 2;
const MAX_INTERVAL_SECONDS = 3600;

function createSpamMode({ getApi, sendMessage, isAuthorized = () => true } = {}) {
  const runs = new Map();

  function stop(threadID) {
    const key = String(threadID || "").trim();
    const run = runs.get(key);
    if (!run) return { stopped: false, threadID: key };
    run.stopped = true;
    if (run.timer) clearTimeout(run.timer);
    runs.delete(key);
    console.log(`[SPAM MODE] stopped thread=${key} sent=${run.sent}`);
    return { stopped: true, threadID: key, sent: run.sent };
  }

  function stopAll(reason = "manual") {
    for (const key of [...runs.keys()]) {
      const result = stop(key);
      console.log(`[SPAM MODE] stopped by ${reason}: thread=${key} sent=${result.sent}`);
    }
  }

  function getStatus() {
    return [...runs.values()].map(run => ({
      threadID: run.threadID,
      intervalSeconds: run.intervalSeconds,
      sent: run.sent,
      nextSendAt: run.nextSendAt,
      startedAt: run.startedAt
    }));
  }

  async function tick(run) {
    if (run.stopped || runs.get(run.threadID) !== run) return;
    if (!isAuthorized()) return stop(run.threadID);
    const api = typeof getApi === "function" ? getApi() : null;
    if (!api || typeof sendMessage !== "function") {
      console.warn(`[SPAM MODE] send skipped: Messenger API unavailable for ${run.threadID}`);
      return stop(run.threadID);
    }
    try {
      await sendMessage(api, run.message, run.threadID);
      if (run.stopped || runs.get(run.threadID) !== run) return;
      run.sent++;
      console.log(`[SPAM MODE] sent ${run.sent} to ${run.threadID}`);
      run.nextSendAt = new Date(Date.now() + run.intervalSeconds * 1000).toISOString();
      run.timer = setTimeout(() => tick(run), run.intervalSeconds * 1000);
      run.timer.unref?.();
    } catch (error) {
      console.error(`[SPAM MODE] stopped after send failure in ${run.threadID}:`, error?.message || error);
      stop(run.threadID);
    }
  }

  function start(input = {}) {
    const threadID = String(input.threadID || "").trim();
    const message = String(input.message || "").trim();
    const intervalSeconds = Number(input.intervalSeconds);
    if (!threadID || threadID.length > 128) throw new Error("Choose a valid Messenger group.");
    if (!message || message.length > 1000) throw new Error("Enter a message between 1 and 1000 characters.");
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error("Spam Mode interval must be between 2 and 3600 seconds.");
    }
    if (!isAuthorized()) throw new Error("Bot must be connected, licensed, and running to start Spam Mode.");
    if (runs.has(threadID)) throw new Error("Spam Mode is already running in this group. Stop it before starting another run.");
    const run = { threadID, message, intervalSeconds, sent: 0, stopped: false, timer: null, startedAt: new Date().toISOString(), nextSendAt: null };
    runs.set(threadID, run);
    run.nextSendAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
    run.timer = setTimeout(() => tick(run), intervalSeconds * 1000);
    run.timer.unref?.();
    console.log(`[SPAM MODE] started thread=${threadID} interval=${intervalSeconds}s unlimited; first send delayed by interval`);
    return { threadID, intervalSeconds, unlimited: true, firstSendInSeconds: intervalSeconds };
  }

  return { start, stop, stopAll, getStatus };
}

module.exports = { createSpamMode, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS };
