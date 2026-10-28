"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const settingsFile = path.join(os.tmpdir(), "test-bot-name-lock-" + process.pid + ".json");
process.env.BOT_SETTINGS_PATH = settingsFile;
const settings = require("../bot-settings");
const { handleThreadNameChange, reconcileLockedGroupNames } = require("../group-name-lock");

test("name lock restores a changed title from the Messenger log event", async t => {
  t.after(() => {
    try { fs.unlinkSync(settingsFile); } catch (_) {}
    delete process.env.BOT_SETTINGS_PATH;
  });

  settings.updateGroup("thread-1", { autoLockNameEnabled: true, lockedThreadName: "Original GC" });
  const calls = [];
  const api = {};
  const setTitle = async (_api, threadID, title) => calls.push({ threadID, title });

  const restored = await handleThreadNameChange(api, {
    type: "event",
    logMessageType: "log:thread-name",
    threadID: "thread-1",
    logMessageData: { name: "Changed by member" }
  }, setTitle);

  assert.equal(restored, true);
  assert.deepEqual(calls, [{ threadID: "thread-1", title: "Original GC" }]);
});

test("name lock checks current thread info when the event omits the new name", async () => {
  settings.updateGroup("thread-2", { autoLockNameEnabled: true, lockedThreadName: "Locked GC" });
  const calls = [];
  const api = {
    getThreadInfo(threadID, callback) {
      callback(null, { threadName: threadID === "thread-2" ? "Renamed GC" : "Locked GC" });
    }
  };
  const setTitle = async (_api, threadID, title) => calls.push({ threadID, title });

  const restored = await handleThreadNameChange(api, {
    type: "event",
    logMessageType: "log:thread-name",
    threadID: "thread-2",
    logMessageData: {}
  }, setTitle);

  assert.equal(restored, true);
  assert.deepEqual(calls, [{ threadID: "thread-2", title: "Locked GC" }]);
});

test("periodic reconciliation restores a locked group even if its change event was missed", async () => {
  settings.updateGroup("thread-3", { autoLockNameEnabled: true, lockedThreadName: "Keep This Name" });
  settings.updateGroup("thread-4", { autoLockNameEnabled: true, lockedThreadName: "Already Correct" });
  const calls = [];
  const api = {
    getThreadInfo(threadID, callback) {
      callback(null, { threadName: threadID === "thread-3" ? "Changed without event" : "Already Correct" });
    }
  };
  const setTitle = async (_api, threadID, title) => calls.push({ threadID, title });

  await reconcileLockedGroupNames(api, setTitle);
  assert.deepEqual(calls, [{ threadID: "thread-3", title: "Keep This Name" }]);
});
