"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require.resolve("../index.js"), "utf8");
const sessionStore = fs.readFileSync(require.resolve("../session-store.js"), "utf8");

test("login lifecycle prevents overlapping attempts and stale callbacks", () => {
  assert.match(source, /if \(loginInProgress\)/);
  assert.match(source, /const generation = \+\+loginGeneration/);
  assert.match(source, /generation !== loginGeneration/);
  assert.match(source, /generation !== activeListenerGeneration/);
  assert.match(source, /queuedReplacementSession/);
});

test("replacement session is promoted only after successful authentication", () => {
  assert.match(source, /A failed replacement must not displace a currently working API/);
  assert.match(source, /start\(api, generation(?:, sessionOverride)?\)/);
  assert.match(source, /normalizeSessionInput\(value\)/);
});

test("retry lifecycle is bounded, singular, and pauses on explicit auth rejection", () => {
  assert.match(source, /if \(loginRetryTimer\) return/);
  assert.match(source, /MAX_LOGIN_BACKOFF_MS = 5 \* 60_000/);
  assert.match(source, /isExplicitSessionRejection\(loginError\)/);
  assert.match(source, /Automatic retries paused/);
  assert.match(source, /isUnverifiableSessionError/);
  assert.match(source, /user ID lookup failed/);
  assert.match(source, /RATE_LIMIT_RETRY_MS = 120_000/);
});

test("session normalization validates c_user and never persists to disk", () => {
  assert.match(sessionStore, /c_user=/i);
  assert.match(sessionStore, /let savedCookie = null/);
  assert.doesNotMatch(sessionStore, /writeFileSync|createCipheriv|dashboard-session\.enc/);
});
