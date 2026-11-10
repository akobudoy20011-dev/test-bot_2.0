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

    await owner.updateLicenseSettings({ max_approved_installations: 1 });
    const secondId = crypto.randomUUID();
    const secondPending = await owner.verifyIncomingInstallation({ installation_id: secondId, repository: "someone/another-fork" });
    assert.equal(secondPending.status, "pending");
    await assert.rejects(
      owner.updateInstallation(secondId, "approved"),
      /Installation limit reached/
    );
    await owner.updateInstallation(unknownId, "revoked");
    await owner.updateInstallation(secondId, "approved");
    assert.equal((await owner.getLicenseSettings()).max_approved_installations, 1);

    const clientDir = path.join(root, "client");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(path.join(clientDir, "installation-id"), secondId);
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

test("temporary installation mode skips identity persistence and owner approval only when explicitly enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-temporary-"));
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Temporary mode must not contact the license authority.");
  };
  try {
    await withEnvironment({
      ECLIPSE_SECURITY_DATA_DIR: root,
      ECLIPSE_INSTALLATION_ID_FILE: path.join(root, "installation-id"),
      ECLIPSE_INSTALLATION_ID: null,
      ECLIPSE_LICENSE_SERVER_MODE: "false",
      ECLIPSE_TEMP_INSTALLATION_MODE: "true",
      ECLIPSE_LICENSE_SERVER_URL: null,
      ECLIPSE_LICENSE_PUBLIC_KEY: null,
      ECLIPSE_LICENSE_PRIVATE_KEY: null
    }, async () => {
      const client = createLicenseGuard();
      assert.equal(await client.initialize(), true);
      const status = client.getStatus();
      assert.equal(status.authorized, true);
      assert.equal(status.mode, "temporary");
      assert.equal(status.status, "temporary");
      assert.match(status.installation_id, /^temporary-/);
      assert.match(status.last_error, /bypassed for this process/);
      assert.equal(client.getInstallationId(), status.installation_id);
      client.startHeartbeat(() => assert.fail("Temporary mode must not start license revocation checks."));
      assert.equal(fs.existsSync(path.join(root, "installation-id")), false);
      client.stop();
    });
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("temporary installation mode does not activate on the license owner service", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-temporary-owner-"));
  try {
    await withEnvironment({
      ECLIPSE_SECURITY_DATA_DIR: root,
      ECLIPSE_LICENSE_ALLOW_FILE_STORE: "true",
      ECLIPSE_LICENSE_SERVER_MODE: "true",
      ECLIPSE_TEMP_INSTALLATION_MODE: "true",
      ECLIPSE_LICENSE_PRIVATE_KEY: null,
      ECLIPSE_LICENSE_PUBLIC_KEY: null,
      ECLIPSE_LICENSE_SERVER_URL: null
    }, async () => {
      const owner = createLicenseGuard();
      assert.equal(await owner.initialize(), false);
      assert.equal(owner.getStatus().mode, "owner");
      assert.equal(owner.getStatus().authorized, false);
      owner.stop();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard key validation accepts normalized header casing and surrounding whitespace only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-dashboard-key-"));
  try {
    await withEnvironment({
      ECLIPSE_SECURITY_DATA_DIR: root,
      ECLIPSE_LICENSE_SERVER_MODE: "false",
      ECLIPSE_DASHBOARD_API_KEY: "  test-dashboard-key  "
    }, async () => {
      const guard = createLicenseGuard();
      assert.equal(guard.dashboardAuthorized({ headers: { "x-eclipse-dashboard-key": "test-dashboard-key" } }), true);
      assert.equal(guard.dashboardAuthorized({ headers: { "X-ECLIPSE-DASHBOARD-KEY": " test-dashboard-key " } }), true);
      assert.equal(guard.dashboardAuthorized({ rawHeaders: ["X-ECLIPSE-DASHBOARD-KEY", "test-dashboard-key"] }), true);
      assert.equal(guard.dashboardAuthorized({ headers: { "x-eclipse-dashboard-key": "wrong-key" } }), false);
      assert.equal(guard.dashboardAuthorized({ headers: { "x-eclipse-dashboard-key": ["test-dashboard-key", "attacker-key"] } }), false);
      guard.stop();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
