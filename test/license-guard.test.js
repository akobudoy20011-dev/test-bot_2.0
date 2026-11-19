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
        ECLIPSE_LICENSE_ENFORCEMENT: "true",
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
    await owner.updateLicenseSettings({ max_approved_installations: 0 });
    const mainBotId = crypto.randomUUID();
    const mainBotPending = await owner.verifyIncomingInstallation({
      app: "mess-bot",
      installation_id: mainBotId,
      repository: "akobudoy20011-dev/mess-bot"
    });
    assert.equal(mainBotPending.status, "pending");
    await owner.updateInstallation(mainBotId, "approved");
    const mainBotApproved = await owner.verifyIncomingInstallation({
      app: "mess-bot",
      installation_id: mainBotId,
      repository: "akobudoy20011-dev/mess-bot"
    });
    assert.equal(mainBotApproved.status, "approved");
    const mainBotPayload = JSON.parse(Buffer.from(mainBotApproved.token.split(".")[0], "base64url").toString("utf8"));
    assert.equal(mainBotPayload.app, "mess-bot");

    owner.stop();
  });

  fs.rmSync(root, { recursive: true, force: true });
});


test("client restores a cached signed approval during an authority outage within offline grace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-offline-cache-"));
  const id = crypto.randomUUID();
  const pair = crypto.generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const now = Date.now();
  const payload = { app: "test-bot_2.0", installation_id: id, status: "approved", iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 600 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = encoded + "." + crypto.sign(null, Buffer.from(encoded), privateKey).toString("base64url");
  const originalFetch = global.fetch;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "installation-id"), id);
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "approved", token }) });
    await withEnvironment({
      ECLIPSE_SECURITY_DATA_DIR: root,
      ECLIPSE_INSTALLATION_ID_FILE: path.join(root, "installation-id"),
      ECLIPSE_LICENSE_SERVER_MODE: "false",
      ECLIPSE_LICENSE_ENFORCEMENT: "true",
      ECLIPSE_LICENSE_SERVER_URL: "https://owner.example",
      ECLIPSE_LICENSE_PUBLIC_KEY: publicKey,
      ECLIPSE_LICENSE_OFFLINE_GRACE_MS: "86400000"
    }, async () => {
      const first = createLicenseGuard({ now: () => now });
      assert.equal(await first.initialize(), true);
      first.stop();
      assert.equal(fs.existsSync(path.join(root, "license-lease")), true);

      global.fetch = async () => { throw new Error("network unavailable"); };
      const restarted = createLicenseGuard({ now: () => now + 11 * 60 * 1000 });
      assert.equal(await restarted.initialize(), true);
      assert.equal(restarted.getStatus().authorized, true);
      assert.equal(restarted.getStatus().status, "offline-authorized");
      assert.ok(restarted.getStatus().offline_grace_until);
      restarted.stop();
    });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit owner revocation clears the cached lease instead of using offline grace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-offline-revoked-"));
  const id = crypto.randomUUID();
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = { app: "test-bot_2.0", installation_id: id, status: "approved", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = encoded + "." + crypto.sign(null, Buffer.from(encoded), pair.privateKey).toString("base64url");
  const originalFetch = global.fetch;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "installation-id"), id);
    fs.writeFileSync(path.join(root, "license-lease"), token);
    global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ status: "revoked" }) });
    await withEnvironment({
      ECLIPSE_SECURITY_DATA_DIR: root,
      ECLIPSE_INSTALLATION_ID_FILE: path.join(root, "installation-id"),
      ECLIPSE_LICENSE_SERVER_MODE: "false",
      ECLIPSE_LICENSE_ENFORCEMENT: "true",
      ECLIPSE_LICENSE_SERVER_URL: "https://owner.example",
      ECLIPSE_LICENSE_PUBLIC_KEY: publicKey
    }, async () => {
      const client = createLicenseGuard();
      assert.equal(await client.initialize(), false);
      assert.equal(client.getStatus().authorized, false);
      assert.equal(fs.existsSync(path.join(root, "license-lease")), false);
      client.stop();
    });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
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
      ECLIPSE_LICENSE_ENFORCEMENT: "true",
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

test("explicit temporary client mode skips owner approval and does not persist an installation identity", async () => {
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
      ECLIPSE_TEMP_INSTALLATION_MODE: null,
      ECLIPSE_LICENSE_ENFORCEMENT: "false",
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
