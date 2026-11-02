"use strict";

const crypto = require("crypto");
const { createLicenseStore } = require("./license-store");

const APP_ID = "test-bot_2.0";
const UPSTREAM_REPOSITORY = "akobudoy20011-dev/test-bot_2.0";
const HEARTBEAT_MS = Math.max(30_000, Number(process.env.ECLIPSE_LICENSE_HEARTBEAT_MS || 60_000));
const LEASE_SAFETY_MS = 15_000;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createLicenseGuard(options = {}) {
  const store = createLicenseStore();
  const ownerMode = /^(1|true|yes|on)$/i.test(process.env.ECLIPSE_LICENSE_SERVER_MODE || "false");
  const serverUrl = String(process.env.ECLIPSE_LICENSE_SERVER_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  const privateKey = process.env.ECLIPSE_LICENSE_PRIVATE_KEY || "";
  const publicKey = process.env.ECLIPSE_LICENSE_PUBLIC_KEY || "";
  const dashboardKey = process.env.ECLIPSE_DASHBOARD_API_KEY || "";
  const now = options.now || (() => Date.now());

  let installationId = "";
  let lease = null;
  let authorized = false;
  let lastCheckAt = null;
  let lastError = null;
  let timer = null;
  let onRevoked = null;

  function record(registry, type, details = {}) {
    registry.events.unshift({ id: crypto.randomUUID(), at: new Date(now()).toISOString(), type, ...details });
    registry.events = registry.events.slice(0, 500);
  }

  function getInstallationId() {
    if (!installationId) installationId = store.getInstallationId();
    return installationId;
  }

  function signLease(payload) {
    if (!privateKey) throw new Error("ECLIPSE_LICENSE_PRIVATE_KEY is not configured on the license owner service.");
    const encoded = encode(payload);
    const signature = crypto.sign(null, Buffer.from(encoded), privateKey).toString("base64url");
    return encoded + "." + signature;
  }

  function verifyLease(token) {
    if (!publicKey || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    try {
      const signature = Buffer.from(parts[1], "base64url");
      if (!crypto.verify(null, Buffer.from(parts[0]), publicKey, signature)) return null;
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      if (payload.app !== APP_ID || payload.installation_id !== getInstallationId()) return null;
      if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now() + LEASE_SAFETY_MS) return null;
      return payload;
    } catch (_) {
      return null;
    }
  }

  function issueLease(id, status) {
    const payload = {
      app: APP_ID,
      installation_id: id,
      status,
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + 10 * 60
    };
    return signLease(payload);
  }

  function dashboardAuthorized(request) {
    const supplied = request && request.headers && request.headers["x-eclipse-dashboard-key"];
    return Boolean(dashboardKey && safeEqual(supplied, dashboardKey));
  }

  function getStatus() {
    return {
      enabled: true,
      mode: ownerMode ? "owner" : "client",
      installation_id: installationId || null,
      authorized,
      status: authorized ? "authorized" : "blocked",
      last_check_at: lastCheckAt,
      last_error: lastError
    };
  }

  async function verifyIncomingInstallation(body) {
    if (!ownerMode) return { status: "unavailable", error: "This installation is not configured as the ECLIPSE license authority." };
    await store.initialize(true);
    const id = String(body && body.installation_id || "").trim();
    if (!/^[a-f0-9-]{32,64}$/i.test(id)) return { status: "invalid", error: "Invalid installation identity." };

    const registry = await store.readRegistry();
    let entry = registry.installations[id];
    if (!entry) {
      entry = {
        installation_id: id,
        app: APP_ID,
        repository: String(body.repository || UPSTREAM_REPOSITORY).slice(0, 200),
        reported_fork: String(body.fork_repository || "").slice(0, 200),
        version: String(body.version || "").slice(0, 40),
        status: id === getInstallationId() ? "approved" : "pending",
        first_seen_at: new Date(now()).toISOString(),
        last_seen_at: new Date(now()).toISOString()
      };
      registry.installations[id] = entry;
      record(registry, "installation-discovered", { installation_id: id, status: entry.status });
    } else {
      entry.last_seen_at = new Date(now()).toISOString();
      if (body.fork_repository) entry.reported_fork = String(body.fork_repository).slice(0, 200);
      if (body.version) entry.version = String(body.version).slice(0, 40);
    }
    await store.writeRegistry(registry);

    if (entry.status !== "approved") return { status: entry.status, installation_id: id };
    return { status: "approved", installation_id: id, token: issueLease(id, "approved") };
  }

  async function checkWithAuthority() {
    if (ownerMode) await store.initialize(ownerMode);
    const id = getInstallationId();
    if (ownerMode) {
      const result = await verifyIncomingInstallation({ installation_id: id, repository: UPSTREAM_REPOSITORY, version: process.version });
      if (result.status !== "approved") throw new Error(result.error || "Owner installation could not authorize itself.");
      lease = result.token || issueLease(id, "approved");
      authorized = true;
      lastError = null;
      lastCheckAt = new Date(now()).toISOString();
      return true;
    }
    if (!serverUrl) throw new Error("ECLIPSE_LICENSE_SERVER_URL is missing; this deployment is not authorized.");
    if (!publicKey) throw new Error("ECLIPSE_LICENSE_PUBLIC_KEY is missing; signed license verification is unavailable.");

    const response = await fetch(serverUrl + "/api/license/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        installation_id: id,
        repository: process.env.ECLIPSE_FORK_REPOSITORY || process.env.GITHUB_REPOSITORY || UPSTREAM_REPOSITORY,
        fork_repository: process.env.ECLIPSE_FORK_REPOSITORY || process.env.GITHUB_REPOSITORY || "",
        version: process.env.npm_package_version || "unknown"
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== "approved") {
      lease = null;
      throw new Error(result.error || "Installation is not approved by the ECLIPSE owner.");
    }
    const verified = verifyLease(result.token);
    if (!verified) {
      authorized = false;
      lease = null;
      throw new Error("The license authority returned an invalid or expired signature.");
    }
    lease = result.token;
    authorized = true;
    lastError = null;
    lastCheckAt = new Date(now()).toISOString();
    return true;
  }

  async function initialize() {
    try {
      await store.initialize(ownerMode);
      getInstallationId();
      await checkWithAuthority();
      return true;
    } catch (error) {
      authorized = false;
      lastError = String(error && error.message || error).slice(0, 300);
      lastCheckAt = new Date(now()).toISOString();
      return false;
    }
  }

  function startHeartbeat(onDenied, onAuthorized) {
    onRevoked = typeof onDenied === "function" ? onDenied : null;
    const onRestored = typeof onAuthorized === "function" ? onAuthorized : null;
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      try {
        const wasAuthorized = authorized;
        await checkWithAuthority();
        if (!wasAuthorized && authorized && onRestored) onRestored();
      } catch (error) {
        const message = String(error && error.message || error);
        const explicitDenial = /not approved|revoked|invalid signature|missing/i.test(message);
        const stillLeased = verifyLease(lease);
        lastError = message.slice(0, 300);
        if (explicitDenial || !stillLeased) {
          const wasAuthorized = authorized;
          authorized = false;
          if (wasAuthorized && onRevoked) onRevoked(lastError);
        }
      }
    }, HEARTBEAT_MS);
    if (timer.unref) timer.unref();
  }

  async function listInstallations() {
    if (!ownerMode) throw new Error("Installation management is available only on the license owner service.");
    return Object.values((await store.readRegistry()).installations).sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
  }

  async function updateInstallation(id, status) {
    if (!ownerMode) throw new Error("Installation management is available only on the license owner service.");
    if (!["approved", "revoked", "pending"].includes(status)) throw new Error("Unsupported installation status.");
    const registry = await store.readRegistry();
    const entry = registry.installations[id];
    if (!entry) throw new Error("Installation not found.");
    if (id === getInstallationId() && status !== "approved") throw new Error("The owner installation cannot be revoked or downgraded.");
    entry.status = status;
    entry.updated_at = new Date(now()).toISOString();
    record(registry, "installation-" + status, { installation_id: id });
    await store.writeRegistry(registry);
    return entry;
  }

  async function listEvents() {
    if (!ownerMode) throw new Error("Security event history is available only on the license owner service.");
    return (await store.readRegistry()).events;
  }

  async function listForks() {
    if (!ownerMode) throw new Error("Fork monitoring is available only on the license owner service.");
    const forks = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch("https://api.github.com/repos/" + UPSTREAM_REPOSITORY + "/forks?per_page=100&page=" + page + "&sort=oldest", {
        headers: { "Accept": "application/vnd.github+json", "User-Agent": "ECLIPSE-Anti-Fork-Monitor" },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error("GitHub fork lookup failed with HTTP " + response.status);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid fork list.");
      forks.push(...batch.map(item => ({
        full_name: item.full_name,
        html_url: item.html_url,
        created_at: item.created_at,
        updated_at: item.updated_at,
        default_branch: item.default_branch,
        private: Boolean(item.private),
        owner: item.owner && item.owner.login
      })));
      if (batch.length < 100) break;
    }
    return forks;
  }

  return {
    getInstallationId,
    getStatus,
    initialize,
    startHeartbeat,
    verifyIncomingInstallation,
    dashboardAuthorized,
    listInstallations,
    updateInstallation,
    listEvents,
    listForks,
    stop() { if (timer) clearInterval(timer); timer = null; store.close().catch(() => {}); }
  };
}

module.exports = { createLicenseGuard, APP_ID, UPSTREAM_REPOSITORY };