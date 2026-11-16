"use strict";

const MIN_INTERVAL_SECONDS = 2;
const MAX_INTERVAL_SECONDS = 3600;
const MAX_MESSAGES = 1000;
const MAX_INPUT_LENGTH = 1000000;

function formatSpamMessage(message) {
  // Numbering is only an input aid; never include list markers in sent messages.
  return String(message ?? "").trim();
}

// Accept both newline-separated lists and compact input such as
// "1. lah 2. oo 3. sige". Existing single-message input remains repeat mode.
function parseSpamInput(input) {
  const text = String(input ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { mode: "repeat", messages: [] };

  const marker = /(^|\s)(\d{1,4})[.)]\s+/g;
  const matches = [...text.matchAll(marker)];
  if (matches.length >= 2 && !text.includes("\n")) {
    const first = matches[0];
    const prefix = text.slice(0, first.index + first[1].length).trim();
    if (!prefix) {
      const messages = matches.map((match, index) => {
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
        return text.slice(start, end).trim();
      }).filter(Boolean);
      if (messages.length === matches.length) return { mode: "sequence", messages };
    }
  }

  const numberedLines = text.split(/\n+/).map(line => line.trim());
  if (numberedLines.length > 1 && numberedLines.every(line => /^\d{1,4}[.)](?:\s+.*)?$/.test(line))) {
    const messages = numberedLines.map(line => line.replace(/^\d{1,4}[.)]\s*/, "").trim()).filter(Boolean);
    return { mode: "sequence", messages };
  }

  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const messages = lines.map(line => line.replace(/^\d{1,4}[.)]\s*/, "").trim()).filter(Boolean);
    if (messages.length === lines.length) return { mode: "sequence", messages };
  }

  return { mode: "repeat", messages: [text.replace(/^1[.)]\s*/, "").trim()] };
}

function createSpamMode({ getApi, sendMessage, isAuthorized = () => true, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const runs = new Map();

  function stop(threadID) {
    const key = String(threadID || "").trim();
    const run = runs.get(key);
    if (!run) return { stopped: false, threadID: key };
    run.stopped = true;
    if (run.timer) clearTimeoutFn(run.timer);
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
      maxMessages: run.totalMessages,
      totalMessages: run.totalMessages,
      mode: run.mode,
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
      const message = run.messages[run.sent % run.messages.length];
      await sendMessage(api, formatSpamMessage(message, run.sent + 1), run.threadID);
      if (run.stopped || runs.get(run.threadID) !== run) return;
      run.sent++;
      console.log(`[SPAM MODE] sent ${run.sent}/${run.totalMessages} to ${run.threadID}`);
      if (run.sent >= run.totalMessages) return stop(run.threadID);
      run.nextSendAt = new Date(Date.now() + run.intervalSeconds * 1000).toISOString();
      run.timer = setTimeoutFn(() => tick(run), run.intervalSeconds * 1000);
      run.timer.unref?.();
    } catch (error) {
      console.error(`[SPAM MODE] stopped after send failure in ${run.threadID}:`, error?.message || error);
      stop(run.threadID);
    }
  }

  function start(input = {}) {
    const threadID = String(input.threadID || "").trim();
    const rawMessage = String(input.message || "").trim();
    const intervalSeconds = Number(input.intervalSeconds);
    if (!threadID || threadID.length > 128) throw new Error("Choose a valid Messenger group.");
    if (!rawMessage || rawMessage.length > MAX_INPUT_LENGTH) throw new Error("Enter a list between 1 and 1,000,000 characters.");
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new Error("Spam Mode interval must be between 2 and 3600 seconds.");
    }
    if (!isAuthorized()) throw new Error("Bot must be connected, licensed, and running to start Spam Mode.");
    if (runs.has(threadID)) throw new Error("Spam Mode is already running in this group. Stop it before starting another run.");

    if (rawMessage.split(/\r?\n/).length > MAX_MESSAGES) throw new Error("Spam Mode lists are limited to 1000 numbered lines.");

    const parsed = parseSpamInput(rawMessage);
    if (!parsed.messages.length || parsed.messages.some(message => !message) || parsed.messages.length > MAX_MESSAGES) {
      throw new Error("Enter between 1 and 1000 non-empty messages.");
    }
    const mode = parsed.mode;
    const messages = parsed.messages;
    // A numbered/multiline list is a finite sequence; a single message keeps
    // the established repeat-until-1000 behavior.
    const totalMessages = mode === "sequence" ? messages.length : MAX_MESSAGES;
    const run = {
      threadID, messages, mode, totalMessages, intervalSeconds, sent: 0,
      stopped: false, timer: null, startedAt: new Date().toISOString(), nextSendAt: null
    };
    runs.set(threadID, run);
    run.nextSendAt = new Date(Date.now() + intervalSeconds * 1000).toISOString();
    run.timer = setTimeoutFn(() => tick(run), intervalSeconds * 1000);
    run.timer.unref?.();
    console.log(`[SPAM MODE] started thread=${threadID} mode=${mode} messages=${totalMessages} interval=${intervalSeconds}s; first send delayed by interval`);
    return {
      threadID, intervalSeconds, maxMessages: totalMessages,
      numbered: true, mode, totalMessages,
      firstSendInSeconds: intervalSeconds
    };
  }

  return { start, stop, stopAll, getStatus };
}

module.exports = {
  createSpamMode, formatSpamMessage, parseSpamInput,
  MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MAX_MESSAGES, MAX_INPUT_LENGTH
};
