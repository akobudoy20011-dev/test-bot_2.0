"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const settingsFile = path.join(os.tmpdir(), "test-bot-settings-" + process.pid + ".json");
process.env.BOT_SETTINGS_PATH = settingsFile;
const settings = require("../bot-settings");

test("reaction and per-group settings validate, persist, and apply quiet hours", (t) => {
  t.after(() => {
    try { fs.unlinkSync(settingsFile); } catch (_) {}
    delete process.env.BOT_SETTINGS_PATH;
  });

  assert.equal(settings.getReactionSettings().emoji, "😆");
  const reaction = settings.updateReaction({
    enabled: true, emoji: "🔥", target: "both", probability: 100, cooldownSeconds: 60
  });
  assert.deepEqual(reaction, {
    enabled: true, emoji: "🔥", target: "both", probability: 100, cooldownSeconds: 60
  });

  const group = settings.updateGroup("123456", {
    banatMode: "off", typingEnabled: false, replyDelayMs: 1250,
    cooldownMs: 0, quietStart: "22:00", quietEnd: "06:00"
  });
  assert.equal(group.threadID, "123456");
  assert.equal(group.banatMode, "off");
  assert.equal(group.typingEnabled, false);
  assert.equal(group.replyDelayMs, 1250);
  assert.equal(group.cooldownMs, 0);
  assert.equal(settings.getGroupSettings("123456").quietStart, "22:00");

  // 17:30 UTC is 01:30 the following day in the Philippines.
  assert.equal(settings.isQuietNow(group, new Date("2026-01-01T17:30:00.000Z")), true);
  assert.equal(settings.isQuietNow(group, new Date("2026-01-01T08:00:00.000Z")), false);

  assert.equal(settings.shouldReact("123456", "bot_replies"), true);
  assert.equal(settings.shouldReact("123456", "incoming_messages"), false, "cooldown applies per group");
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).groups["123456"].banatMode, "off");
});
