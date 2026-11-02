"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { createLicenseGuard } = require("../license-guard");

async function withEnvironment(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await callback(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("owner service approves itself and requires explicit approval for new installations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

  await withEnvironment({
    ECLIPSE_SECURITY_DATA_DIR: path.join(root, "owner"),
    ECLIPSE_LICENSE_ALLOW_FILE_STORE: "true",
    ECLIPSE_LICENSE_SERVER_MODE: "true",
    ECLIPSE_LICENSE_PRIVATE_KEY: privateKey,
    ECLIPSE_LICENSE_PUBLIC_KEY: publicKey,
    ECLIPSE_DASHBOARD_API_KEY: "test-dashboard-key",
    ECLIPSE_LICENSE_SERVER_URL: null
  }, async () => {
    const owner = createLicenseGuard();
    assert.equal(await owner.initialize(), true);
    const unknownId = crypto.randomUUID();
    const pending = await owner.verifyIncomingInstallation({ installation_id: unknownId, repository: "someone/test-bot" });
    assert.equal(pending.status, "pending");
    await owner.updateInstallation(unknownId, "approved");
    const approved = await owner.verifyIncomingInstallation({ installation_id: unknownId });
    assert.equal(approved.status, "approved");
    assert.ok(approved.token);

    const clientDir = path.join(root, "client");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, "installation-id"), unknownId);
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      const result = await owner.verifyIncomingInstallation(JSON.parse(options.body));
      return { ok: result.status === "approved", status: result.status === "approved" ? 200 : 403, json: async () => result };
    };
    try {
      await withEnvironment({
        ECLIPSE_SECURITY_DATA_DIR: clientDir,
      ECLIPSE_LICENSE_ALLOW_FILE_STORE: "true",
        ECLIPSE_INSTALLATION_ID_FILE: path.join(clientDir, "installation-id"),
        ECLIPSE_LICENSE_SERVER_MODE: "false",
        ECLIPSE_LICENSE_SERVER_URL: "https://owner.example",
        ECLIPSE_LICENSE_PUBLIC_KEY: publicKey,
        ECLIPSE_LICENSE_PRIVATE_KEY: null
      }, async () => {
        const client = createLicenseGuard();
        assert.equal(await client.initialize(), true);
        assert.equal(client.getStatus().authorized, true);
      });
    } finally {
      global.fetch = originalFetch;
    }
    owner.stop();
  });

  fs.rmSync(root, { recursive: true, force: true });
});

test("an unapproved installation remains blocked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-pending-"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const id = crypto.randomUUID();
  const originalFetch = global.fetch;
  const clientDir = path.join(root, "client");
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, "installation-id"), id);

  global.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ status: "pending", error: "Installation awaits owner approval." })
  });
  try {
    await withEnvironment({
      ECLIPSE_SECURITY_DATA_DIR: clientDir,
      ECLIPSE_INSTALLATION_ID_FILE: path.join(clientDir, "installation-id"),
      ECLIPSE_LICENSE_SERVER_MODE: "false",
      ECLIPSE_LICENSE_SERVER_URL: "https://owner.example",
      ECLIPSE_LICENSE_PUBLIC_KEY: publicKey,
      ECLIPSE_LICENSE_PRIVATE_KEY: null
    }, async () => {
      const client = createLicenseGuard();
      assert.equal(await client.initialize(), false);
      assert.equal(client.getStatus().authorized, false);
      client.stop();
    });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});