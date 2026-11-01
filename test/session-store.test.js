"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

function freshStore() {
  delete require.cache[require.resolve("../session-store")];
  return require("../session-store");
}

test("dashboard session store keeps normalized cookie in memory", () => {
  const store = freshStore();
  const cookie = "c_user=12345; xs=secret-cookie-value";
  store.save(cookie);
  assert.equal(store.read(), cookie);
  assert.deepEqual(store.status(), { configured: true, storage: "memory", survivesRestart: false });
  store.clear();
  assert.equal(store.read(), null);
  assert.equal(store.status().configured, false);
});

test("dashboard session store accepts JSON appstate arrays and normalizes them", () => {
  const store = freshStore();
  const appstate = JSON.stringify([
    { key: "c_user", value: "12345", domain: ".facebook.com" },
    { name: "xs", value: "secret-cookie-value" }
  ]);
  store.save(appstate);
  assert.equal(store.read(), "c_user=12345; xs=secret-cookie-value");
});

test("dashboard session store accepts appstate/cookies wrapper objects", () => {
  const store = freshStore();
  store.save(JSON.stringify({ appState: [{ key: "c_user", value: "99" }, { key: "xs", value: "token" }] }));
  assert.equal(store.read(), "c_user=99; xs=token");
  store.save(JSON.stringify({ cookies: [{ name: "c_user", value: "77" }] }));
  assert.equal(store.read(), "c_user=77");
});

test("dashboard session store rejects malformed or incomplete sessions", () => {
  const store = freshStore();
  assert.throws(() => store.save("  "), /valid session/);
  assert.throws(() => store.save("not-json{"), /single line|JSON appstate/);
  assert.throws(() => store.save(JSON.stringify([{ key: "xs", value: "only-xs" }])), /c_user/);
  assert.throws(() => store.save("xs=only-xs"), /c_user/);
});
