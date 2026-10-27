"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startTyping, stopTyping, withTyping } = require("../human-typing");

test("uses ws3-fca v2 sendTypingIndicator(active, threadID, callback) signature", () => {
  const calls = [];
  const api = {
    sendTypingIndicator(active, threadID, callback) {
      calls.push({ active, threadID, callbackType: typeof callback });
      callback(null);
      return Promise.resolve();
    }
  };

  assert.equal(startTyping(api, "thread-123"), true);
  assert.equal(stopTyping(api, "thread-123"), true);
  assert.deepEqual(calls.map(({ active, threadID, callbackType }) => ({ active, threadID, callbackType })), [
    { active: true, threadID: "thread-123", callbackType: "function" },
    { active: false, threadID: "thread-123", callbackType: "function" }
  ]);
});

test("falls back to legacy sendTyping(threadID, active)", () => {
  const calls = [];
  const api = { sendTyping(threadID, active) { calls.push([threadID, active]); } };
  assert.equal(startTyping(api, "thread-legacy"), true);
  assert.equal(stopTyping(api, "thread-legacy"), true);
  assert.deepEqual(calls, [["thread-legacy", true], ["thread-legacy", false]]);
});

test("typing API errors are non-fatal", () => {
  const api = { sendTypingIndicator() { throw new Error("offline"); } };
  assert.equal(startTyping(api, "thread-error"), false);
  assert.equal(stopTyping(api, "thread-error"), false);
});

test("withTyping stops indicator after send resolves", async () => {
  const calls = [];
  const api = { sendTypingIndicator(active, threadID) { calls.push([active, threadID]); } };
  const result = await withTyping(api, "thread-send", 0, async () => "sent");
  assert.equal(result, "sent");
  assert.deepEqual(calls, [[true, "thread-send"], [false, "thread-send"]]);
});
