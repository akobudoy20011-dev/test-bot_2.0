"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpamMode } = require("../spam-mode");

test("Spam Mode validates a selected group, message, interval, and bounded count", () => {
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 5, maxMessages: 2 }), /between 6 and 3600/);
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 6, maxMessages: 101 }), /1–100/);
  assert.throws(() => spam.start({ threadID: "", message: "hello", intervalSeconds: 6, maxMessages: 2 }), /valid Messenger group/);
});

test("Spam Mode waits for the configured interval before the first send and can be stopped", async () => {
  let sends = 0;
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => { sends++; }, isAuthorized: () => true });
  const started = spam.start({ threadID: "group-1", message: "hello", intervalSeconds: 6, maxMessages: 3 });
  assert.equal(started.firstSendInSeconds, 6);
  assert.equal(sends, 0);
  assert.equal(spam.getStatus().length, 1);
  const stopped = spam.stop("group-1");
  assert.equal(stopped.stopped, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  assert.deepEqual(spam.getStatus(), []);
});

test("Spam Mode rejects duplicate runs and unauthorized starts", () => {
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => false });
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 6, maxMessages: 2 }), /must be connected/);
  const allowed = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  allowed.start({ threadID: "g", message: "hello", intervalSeconds: 6, maxMessages: 2 });
  assert.throws(() => allowed.start({ threadID: "g", message: "again", intervalSeconds: 6, maxMessages: 2 }), /already running/);
  allowed.stopAll("test");
});
