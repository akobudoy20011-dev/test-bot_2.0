"use strict";

const crypto = require("crypto");
const { createLicenseStore } = require("./license-store");

const APP_ID = "test-bot_2.0";
const UPSTREAM_REPOSITORY = "akobudoy20011-dev/test-bot_2.0";
const HEARTBEAT_MS = Math.max(30_000, Number(process.env.ECLIPSE_LICENSE_HEARTBEAT_MS || 60_000));
const LEASE_SAFETY_MS = 15_000;
const LICENSE_REQUEST_TIMEOUT_MS = Math.min(60_000, Math.max(5_000, Number(process.env.ECLIPSE_LICENSE_REQUEST_TIMEOUT_MS || 30_000)));

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
  // Explicit, client-only escape hatch for temporary testing while installation registration is unavailable.
  const temporaryMode = !ownerMode && /^(1|true|yes|on)$/i.test(process.env.ECLIPSE_TEMP_INSTALLATION_MODE || "false");
  const temporaryInstallationId = temporaryMode ? "temporary-" + crypto.randomUUID() : "";
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
  let mutationQueue = Promise.resolve();

  function serializeMutation(operation) {
    const result = mutationQueue.then(operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  function record(registry, type, details = {}) {
    registry.events.unshift({ id: crypto.randomUUID(), at: new Date(now()).toISOString(), type, ...details });
    registry.events = registry.events.slice(0, 500);
  }

  function getInstallationId() {
    if (temporaryMode) return temporaryInstallationId;
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
      mode: ownerMode ? "owner" : temporaryMode ? "temporary" : "client",
      installation_id: temporaryMode ? temporaryInstallationId : installationId || null,
      authorized,
      status: temporaryMode && authorized ? "temporary" : authorized ? "authorized" : "blocked",
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

    const verificationUrl = new URL("/api/license/verify", serverUrl).toString();
    const requestId = crypto.randomUUID();
    const startedAt = now();
    console.info("[ECLIPSE LICENSE] Verification request started", {
      request_id: requestId,
      authority: new URL(verificationUrl).origin,
      timeout_ms: LICENSE_REQUEST_TIMEOUT_MS
    });
    let response;
    try {
      response = await fetch(verificationUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-ECLIPSE-REQUEST-ID": requestId
        },
        body: JSON.stringify({
          installation_id: id,
          repository: process.env.ECLIPSE_FORK_REPOSITORY || process.env.GITHUB_REPOSITORY || UPSTREAM_REPOSITORY,
          fork_repository: process.env.ECLIPSE_FORK_REPOSITORY || process.env.GITHUB_REPOSITORY || "",
          version: process.env.npm_package_version || "unknown"
        }),
        signal: AbortSignal.timeout(LICENSE_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      const elapsedMs = Math.max(0, now() - startedAt);
      console.warn("[ECLIPSE LICENSE] Verification request failed before an HTTP response", {
        request_id: requestId,
        authority: new URL(verificationUrl).origin,
        elapsed_ms: elapsedMs,
        error: String(error && error.message || error).slice(0, 240)
      });
      throw new Error("Could not reach the ECLIPSE license authority within " + elapsedMs + "ms. Check the authority URL and its availability.");
    }
    const elapsedMs = Math.max(0, now() - startedAt);
    console.info("[ECLIPSE LICENSE] Verification response received", {
      request_id: requestId,
      http_status: response.status,
      elapsed_ms: elapsedMs
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== "approved") {
      lease = null;
      if (result.status === "pending") {
        throw new Error("Installation is pending owner approval. Share this installation ID with the owner: " + id);
      }
      if (result.status === "revoked") {
        throw new Error("This installation license has been revoked. Installation ID: " + id);
      }
      throw new Error(result.error || "Installation is not approved by the ECLIPSE owner. Installation ID: " + id);
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
      if (temporaryMode) {
        installationId = temporaryInstallationId;
        authorized = true;
        lastCheckAt = new Date(now()).toISOString();
        lastError = "Temporary installation mode is active; owner license approval and signed-lease checks are bypassed for this process.";
        console.warn("[ECLIPSE LICENSE] TEMPORARY INSTALLATION MODE enabled. License authority checks are bypassed until this environment flag is removed.");
        return true;
      }
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
    if (temporaryMode) return;
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

  async function getLicenseSettings() {
    if (!ownerMode) throw new Error("License settings are available only on the license owner service.");
    const registry = await store.readRegistry();
    const raw = Number(registry.settings && registry.settings.max_approved_installations || 0);
    return { max_approved_installations: Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0 };
  }

  async function updateLicenseSettings(input = {}) {
    return serializeMutation(async () => {
      if (!ownerMode) throw new Error("License settings are available only on the license owner service.");
      const value = Number(input.max_approved_installations);
      if (!Number.isInteger(value) || value < 0 || value > 10000) {
        throw new Error("Maximum approved installations must be a whole number from 0 to 10000. Use 0 for unlimited.");
      }
      const registry = await store.readRegistry();
      registry.settings = { max_approved_installations: value };
      record(registry, "license-settings-updated", { max_approved_installations: value });
      await store.writeRegistry(registry);
      return registry.settings;
    });
  }

  async function updateInstallation(id, status) {
    return serializeMutation(async () => {
      if (!ownerMode) throw new Error("Installation management is available only on the license owner service.");
      if (!["approved", "revoked", "pending"].includes(status)) throw new Error("Unsupported installation status.");
      const registry = await store.readRegistry();
      const entry = registry.installations[id];
      if (!entry) throw new Error("Installation not found.");
      if (id === getInstallationId() && status !== "approved") throw new Error("The owner installation cannot be revoked or downgraded.");
      if (status === "approved" && entry.status !== "approved") {
        const limit = Number(registry.settings && registry.settings.max_approved_installations || 0);
        const approvedCount = Object.values(registry.installations).filter(item =>
          item && item.status === "approved" && item.installation_id !== getInstallationId()
        ).length;
        if (limit > 0 && approvedCount >= limit) {
          throw new Error("Installation limit reached (" + approvedCount + "/" + limit + "). Revoke an installation or increase the limit before approving another.");
        }
      }
      entry.status = status;
      entry.updated_at = new Date(now()).toISOString();
      record(registry, "installation-" + status, { installation_id: id });
      await store.writeRegistry(registry);
      return entry;
    });
  }

  async function listEvents() {
    if (!ownerMode) throw new Error("Security event history is available only on the license owner service.");
    return (await store.readRegistry()).events;
  }

  async function listForks() {
    if (!ownerMode) throw new Error("Fork monitoring is available only on the license owner service.");

    const token = process.env.ECLIPSE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    const headers = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "ECLIPSE-Anti-Fork-Monitor",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (token) headers.Authorization = "Bearer " + token;

    const forks = [];
    for (let page = 1; page <= 10; page++) {
      const response = await fetch("https://api.github.com/repos/" + UPSTREAM_REPOSITORY + "/forks?per_page=100&page=" + page + "&sort=oldest", {
        headers,
        signal: AbortSignal.timeout(12_000)
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const remaining = response.headers.get("x-ratelimit-remaining");
        const reset = response.headers.get("x-ratelimit-reset");
        const retryAfter = response.headers.get("retry-after");
        const detail = String(body.message || body.error || response.statusText || "Unknown GitHub API error").slice(0, 240);
        const rateLimited = response.status === 429 || (response.status === 403 && (remaining === "0" || /rate limit/i.test(detail)));
        const hint = rateLimited
          ? " GitHub rate limit reached" + (reset ? "; reset at " + new Date(Number(reset) * 1000).toISOString() : retryAfter ? "; retry after " + retryAfter + " seconds" : ".")
          : response.status === 403
            ? " Check the GitHub token's repository access and fork metadata permissions."
            : "";
        throw new Error("GitHub fork lookup failed with HTTP " + response.status + ": " + detail + "." + hint);
      }

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
    getLicenseSettings,
    updateLicenseSettings,
    listEvents,
    listForks,
    stop() { if (timer) clearInterval(timer); timer = null; store.close().catch(() => {}); }
  };
}

module.exports = { createLicenseGuard, APP_ID, UPSTREAM_REPOSITORY };
