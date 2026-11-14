"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpamMode } = require("../spam-mode");

test("Spam Mode requires a valid group, custom message, and interval of at least two seconds", () => {
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 1 }), /between 2 and 3600/);
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 3601 }), /between 2 and 3600/);
  assert.throws(() => spam.start({ threadID: "", message: "hello", intervalSeconds: 2 }), /valid Messenger group/);
  assert.throws(() => spam.start({ threadID: "g", message: "", intervalSeconds: 2 }), /message between 1 and 1000/);
});

test("Spam Mode is unlimited, waits before first send, and can be stopped", async () => {
  let sends = 0;
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => { sends++; }, isAuthorized: () => true });
  const started = spam.start({ threadID: "group-1", message: "custom words", intervalSeconds: 2 });
  assert.equal(started.firstSendInSeconds, 2);
  assert.equal(started.unlimited, true);
  assert.equal(sends, 0);
  assert.equal(spam.getStatus()[0].intervalSeconds, 2);
  assert.equal("maxMessages" in spam.getStatus()[0], false);
  const stopped = spam.stop("group-1");
  assert.equal(stopped.stopped, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  assert.deepEqual(spam.getStatus(), []);
});

test("Spam Mode rejects duplicate runs and unauthorized starts", () => {
  const denied = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => false });
  assert.throws(() => denied.start({ threadID: "g", message: "hello", intervalSeconds: 2 }), /must be connected/);
  const allowed = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  allowed.start({ threadID: "g", message: "hello", intervalSeconds: 2 });
  assert.throws(() => allowed.start({ threadID: "g", message: "again", intervalSeconds: 2 }), /already running/);
  allowed.stopAll("test");
});
