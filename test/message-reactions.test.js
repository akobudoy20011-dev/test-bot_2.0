"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractMessageID, dispatchMessageReaction } = require("../message-reactions");

test("extracts message IDs from supported Messenger send result shapes", () => {
  assert.equal(extractMessageID("message-1"), "message-1");
  assert.equal(extractMessageID({ messageID: "message-2" }), "message-2");
  assert.equal(extractMessageID({ messageId: "message-3" }), "message-3");
  assert.equal(extractMessageID({ message_id: "message-4" }), "message-4");
  assert.equal(extractMessageID({ id: "message-5" }), "message-5");
  assert.equal(extractMessageID({ message: { id: "message-6" } }), "message-6");
  assert.equal(extractMessageID({}), null);
});

test("prefers MQTT reaction publishing with exact emoji, message and thread IDs", () => {
  const calls = [];
  const statuses = [];
  const api = {
    setMessageReactionMqtt(...args) { calls.push(args.slice(0, 3)); }
  };
  const result = dispatchMessageReaction(api, "😆", "message-1", "group-1", {
    onStatus: (status, detail) => statuses.push([status, detail.method])
  });
  assert.deepEqual(calls, [["😆", "message-1", "group-1"]]);
  assert.deepEqual(result, { ok: true, method: "setMessageReactionMqtt" });
  assert.deepEqual(statuses, [["submitted", "setMessageReactionMqtt"]]);
});

test("falls back to setMessageReaction when MQTT publishing throws", () => {
  const calls = [];
  const statuses = [];
  const api = {
    setMessageReactionMqtt() { throw new Error("MQTT unavailable"); },
    setMessageReaction(emoji, messageID, callback, force) {
      calls.push([emoji, messageID, force]);
      callback(null, { success: true });
    }
  };
  dispatchMessageReaction(api, "😆", "message-2", "group-1", {
    onStatus: (status, detail) => statuses.push([status, detail.method])
  });
  assert.deepEqual(calls, [["😆", "message-2", true]]);
  assert.deepEqual(statuses, [
    ["fallback", "mqtt"],
    ["submitted", "setMessageReaction"]
  ]);
});

test("uses the regular reaction API when MQTT is unavailable", () => {
  let called = false;
  const api = {
    setMessageReaction(emoji, messageID, callback, force) {
      called = true;
      assert.equal(emoji, "🔥");
      assert.equal(messageID, "message-3");
      assert.equal(force, true);
      callback(null, { success: true });
    }
  };
  const statuses = [];
  dispatchMessageReaction(api, "🔥", "message-3", "group-1", {
    onStatus: status => statuses.push(status)
  });
  assert.equal(called, true);
  assert.deepEqual(statuses, ["submitted"]);
});

test("reports missing message or thread IDs and unavailable reaction APIs", () => {
  const statuses = [];
  const missing = dispatchMessageReaction({}, "😆", "", "group-1", {
    onStatus: status => statuses.push(status)
  });
  assert.equal(missing.ok, false);
  const unavailable = dispatchMessageReaction({}, "😆", "message-4", "group-1", {
    onStatus: status => statuses.push(status)
  });
  assert.equal(unavailable.ok, false);
  assert.deepEqual(statuses, ["failed", "failed"]);
});
