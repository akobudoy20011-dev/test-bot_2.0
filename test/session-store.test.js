"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-bot-session-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.ECLIPSE_SESSION_ENCRYPTION_KEY;
  process.chdir(dir);
  process.env.ECLIPSE_SESSION_ENCRYPTION_KEY = "test-only-encryption-key-32-bytes-minimum";
  try { return run(require("../session-store"), dir); }
  finally {
    delete require.cache[require.resolve("../session-store")];
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.ECLIPSE_SESSION_ENCRYPTION_KEY;
    else process.env.ECLIPSE_SESSION_ENCRYPTION_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("dashboard session store encrypts saved cookie headers and reads them back", () => {
  withStore((store, dir) => {
    const file = path.join(dir, "data", "dashboard-session.enc");
    const cookie = "c_user=12345; xs=secret-cookie-value";
    store.save(cookie);
    const encrypted = fs.readFileSync(file, "utf8");
    assert.equal(encrypted.includes("secret-cookie-value"), false);
    assert.equal(store.read(), cookie);
    assert.deepEqual(store.status(), { configured: true, storage: "encrypted" });
    store.clear();
    assert.equal(store.read(), null);
  });
});

test("dashboard session store accepts JSON appstate arrays and normalizes them", () => {
  withStore((store, dir) => {
    const appstate = JSON.stringify([
      { key: "c_user", value: "12345", domain: ".facebook.com", expirationDate: 1801338234 },
      { name: "xs", value: "secret-cookie-value", partitionKey: null, storeId: null }
    ], null, 2);
    store.save(appstate);
    assert.equal(store.read(), "c_user=12345; xs=secret-cookie-value");
    const encrypted = fs.readFileSync(path.join(dir, "data", "dashboard-session.enc"), "utf8");
    assert.equal(encrypted.includes("secret-cookie-value"), false);
    assert.equal(encrypted.includes("expirationDate"), false);
  });
});

test("dashboard session store accepts appstate/cookies wrapper objects", () => {
  withStore(store => {
    store.save(JSON.stringify({ appState: [{ key: "c_user", value: "99" }, { key: "xs", value: "token" }] }));
    assert.equal(store.read(), "c_user=99; xs=token");
    store.save(JSON.stringify({ cookies: [{ name: "c_user", value: "77" }] }));
    assert.equal(store.read(), "c_user=77");
  });
});

test("dashboard session store rejects missing encryption key and malformed sessions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-bot-session-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.ECLIPSE_SESSION_ENCRYPTION_KEY;
  process.chdir(dir);
  process.env.ECLIPSE_SESSION_ENCRYPTION_KEY = "short";
  try {
    const store = require("../session-store");
    assert.throws(() => store.save("c_user=123"), /at least 32 bytes/);
    process.env.ECLIPSE_SESSION_ENCRYPTION_KEY = "test-only-encryption-key-32-bytes-minimum";
    assert.throws(() => store.save("  "), /valid session/);
    assert.throws(() => store.save("not-json{"), /single line|JSON appstate/);
    assert.throws(() => store.save(JSON.stringify([{ key: "xs", value: "only-xs" }])), /no valid cookie entries/);
    assert.throws(() => store.save("xs=only-xs"), /c_user/);
  } finally {
    delete require.cache[require.resolve("../session-store")];
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.ECLIPSE_SESSION_ENCRYPTION_KEY;
    else process.env.ECLIPSE_SESSION_ENCRYPTION_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
