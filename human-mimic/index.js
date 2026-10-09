"use strict";

const mimic = require("../human-mimic");
const delay = require("../human-delay");
const typing = require("../human-typing");

/**
 * Single public facade for all human-like Banat behavior.
 *
 * Text transformation, timing math, and typing lifecycle stay separated,
 * while callers get one stable import surface.
 */

function createHumanContext(threadID, incomingText = "", state = new Map()) {
  const key = String(threadID || "unknown");
  const now = Date.now();
  const incoming = String(incomingText || "");
  const previous = state.get(key);

  const withinWindow =
    previous &&
    now - Number(previous.at || 0) < 45_000;

  const recentMessages = withinWindow
    ? Math.min(8, Number(previous.count || 0) + 1)
    : 1;

  const incomingWords = delay.countWords(incoming);
  const incomingChars = incoming.length;

  let mode = "chill";
  if (recentMessages >= 5) {
    mode = "rushed";
  } else if (recentMessages >= 3) {
    mode = "normal";
  }

  const momentum = Math.max(
    1,
    recentMessages +
      (incomingWords >= 18 ? 1 : 0) +
      (incomingWords >= 35 ? 1 : 0)
  );

  state.set(key, {
    at: now,
    count: recentMessages,
    mode,
    incomingWords,
    incomingChars,
  });

  return {
    threadID: key,
    incomingText: incoming,
    incomingWords,
    incomingChars,
    recentMessages,
    momentum,
    mode,
    elapsedSincePreviousMs: withinWindow
      ? Math.max(0, now - Number(previous.at || now))
      : null,
  };
}

function prepareReply(text, options = {}) {
  const context = options.context || {};
  const output = mimic.humanize(text, options);
  const timing = delay.calculateHumanDelay(output, context, options);
  return { text: output, timing, context };
}

module.exports = {
  ...mimic,
  ...delay,
  ...typing,
  createHumanContext,
  prepareReply,
};
