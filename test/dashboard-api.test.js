"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("dashboard serves UI and protects control endpoints", async (t) => {
  const previousKey = process.env.ECLIPSE_DASHBOARD_API_KEY;
  const previousOrigin = process.env.ECLIPSE_DASHBOARD_ORIGIN;
  process.env.ECLIPSE_DASHBOARD_API_KEY = "test-dashboard-key";
  process.env.ECLIPSE_DASHBOARD_ORIGIN = "*";

  const startDashboardApi = require("../dashboard-api");
  let paused = false;
  const server = startDashboardApi(0, () => ({
    ok: true,
    facebook_connected: true,
    bot_running: !paused,
    last_listener_error: null,
    last_message_at: "2026-10-26T00:00:00.000Z"
  }), {
    setPaused(value) { paused = Boolean(value); },
    getPaused() { return paused; },
    setRecordEvent(record) { this.recordEvent = record; },
    getSettings() { return { reaction, groups: group ? { [group.threadID]: group } : {} }; },
    updateReaction(value) { reaction = { ...reaction, ...value }; return reaction; },
    updateGroup(threadID, value) { group = { threadID, banatMode: value.banatMode || "inherit", typingEnabled: value.typingEnabled !== false }; return group; }
  });

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => {
    server.close();
    if (previousKey === undefined) delete process.env.ECLIPSE_DASHBOARD_API_KEY;
    else process.env.ECLIPSE_DASHBOARD_API_KEY = previousKey;
    if (previousOrigin === undefined) delete process.env.ECLIPSE_DASHBOARD_ORIGIN;
    else process.env.ECLIPSE_DASHBOARD_ORIGIN = previousOrigin;
  });

  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base + "/dashboard");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Banat Test Bot/);

  const unauthorized = await fetch(base + "/api/dashboard/status");
  assert.equal(unauthorized.status, 401);

  const headers = { "X-Eclipse-Dashboard-Key": "test-dashboard-key" };
  const status = await fetch(base + "/api/dashboard/status", { headers });
  assert.equal(status.status, 200);
  const data = await status.json();
  assert.equal(data.facebook_connected, true);
  assert.equal(data.bot_paused, false);
  assert.equal(typeof data.uptime_seconds, "number");
  assert.equal(data.last_listener_error, null);
  assert.equal(data.last_message_at, "2026-10-26T00:00:00.000Z");

  const pause = await fetch(base + "/api/dashboard/bot/stop", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}"
  });
  assert.equal(pause.status, 200);
  assert.equal(paused, true);

  const events = await fetch(base + "/api/dashboard/events", { headers });
  assert.equal(events.status, 200);
  assert.equal((await events.json()).events[0].type, "bot-paused");

  const settingsBefore = await fetch(base + "/api/dashboard/settings", { headers });
  assert.equal(settingsBefore.status, 200);
  assert.equal((await settingsBefore.json()).settings.reaction.emoji, "😆");

  const reactionSave = await fetch(base + "/api/dashboard/settings/reaction", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "🔥", target: "both", probability: 75, cooldownSeconds: 5 })
  });
  assert.equal(reactionSave.status, 200);
  assert.equal((await reactionSave.json()).reaction.emoji, "🔥");

  const groupSave = await fetch(base + "/api/dashboard/settings/group", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ threadID: "123456", banatMode: "off", typingEnabled: false })
  });
  assert.equal(groupSave.status, 200);
  assert.equal((await groupSave.json()).group.threadID, "123456");
});
