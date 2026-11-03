"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("ECLIPSE_INSTALLATION_ID overrides generated filesystem identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-store-"));
  const previous = {
    dataDir: process.env.ECLIPSE_SECURITY_DATA_DIR,
    idFile: process.env.ECLIPSE_INSTALLATION_ID_FILE,
    installationId: process.env.ECLIPSE_INSTALLATION_ID
  };
  const expected = "19bdea9d-d43d-41d1-ba55-9c603db9c7e0";

  try {
    process.env.ECLIPSE_SECURITY_DATA_DIR = dir;
    process.env.ECLIPSE_INSTALLATION_ID_FILE = path.join(dir, "installation-id");
    process.env.ECLIPSE_INSTALLATION_ID = expected;

    const { createLicenseStore } = require("../license-store");
    const store = createLicenseStore();

    assert.equal(store.getInstallationId(), expected);
    assert.equal(fs.readFileSync(path.join(dir, "installation-id"), "utf8").trim(), expected);
  } finally {
    for (const [key, value] of Object.entries({
      ECLIPSE_SECURITY_DATA_DIR: previous.dataDir,
      ECLIPSE_INSTALLATION_ID_FILE: previous.idFile,
      ECLIPSE_INSTALLATION_ID: previous.installationId
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid ECLIPSE_INSTALLATION_ID is rejected instead of silently generating a new ID", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eclipse-license-store-invalid-"));
  const previous = {
    dataDir: process.env.ECLIPSE_SECURITY_DATA_DIR,
    idFile: process.env.ECLIPSE_INSTALLATION_ID_FILE,
    installationId: process.env.ECLIPSE_INSTALLATION_ID
  };

  try {
    process.env.ECLIPSE_SECURITY_DATA_DIR = dir;
    process.env.ECLIPSE_INSTALLATION_ID_FILE = path.join(dir, "installation-id");
    process.env.ECLIPSE_INSTALLATION_ID = "not-a-valid-installation-id";

    const { createLicenseStore } = require("../license-store");
    const store = createLicenseStore();

    assert.throws(() => store.getInstallationId(), /ECLIPSE_INSTALLATION_ID must be a UUID/);
  } finally {
    for (const [key, value] of Object.entries({
      ECLIPSE_SECURITY_DATA_DIR: previous.dataDir,
      ECLIPSE_INSTALLATION_ID_FILE: previous.idFile,
      ECLIPSE_INSTALLATION_ID: previous.installationId
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
