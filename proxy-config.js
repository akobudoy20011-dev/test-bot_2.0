"use strict";

const https = require("https");
const HttpsProxyAgent = require("https-proxy-agent");
const { ProxyAgent, setGlobalDispatcher } = require("undici");

function configureGlobalFetchProxy(proxyUrl) {
  const dispatcher = new ProxyAgent(proxyUrl);
  setGlobalDispatcher(dispatcher);
  return dispatcher;
}

const IPINFO_URL = "https://ipinfo.io/json";
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 16 * 1024;

function parseProxyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("PROXY_URL is required. Messenger login is blocked until an HTTP/HTTPS proxy is configured; direct fallback is disabled.");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error("PROXY_URL is invalid. Use http://USER:PASS@HOST:PORT or https://USER:PASS@HOST:PORT.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash) {
    throw new Error("PROXY_URL must be an HTTP/HTTPS proxy URL with an explicit port and no path, query, or fragment.");
  }

  return parsed.toString();
}

function verifyProxyLocation(proxyUrl, options = {}) {
  const httpsImpl = options.httpsImpl || https;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const agent = new HttpsProxyAgent(proxyUrl);

  return new Promise(resolve => {
    let settled = false;
    let request;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      request = httpsImpl.get(IPINFO_URL, {
        agent,
        headers: { Accept: "application/json" },
        timeout: timeoutMs
      }, response => {
        const chunks = [];
        let bytes = 0;

        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request?.destroy();
            finish({ ok: false, error: "response_too_large" });
            return;
          }
          chunks.push(Buffer.from(chunk));
        });

        response.on("error", () => finish({ ok: false, error: "response_error" }));
        response.on("end", () => {
          if (settled) return;
          if (response.statusCode !== 200) {
            finish({ ok: false, error: "http_" + Number(response.statusCode || 0) });
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish({
              ok: true,
              country: String(data.country || "").toUpperCase(),
              city: String(data.city || ""),
              region: String(data.region || "")
            });
          } catch (_) {
            finish({ ok: false, error: "invalid_response" });
          }
        });
      });

      request.setTimeout?.(timeoutMs, () => {
        request.destroy(new Error("timeout"));
        finish({ ok: false, error: "timeout" });
      });
      request.on("error", error => {
        finish({
          ok: false,
          error: error?.code === "ETIMEDOUT" ? "timeout" : "proxy_connection_failed"
        });
      });
    } catch (_) {
      finish({ ok: false, error: "proxy_check_failed" });
    }
  });
}

function createProxyManager(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const verifyLocation = options.verifyLocation || verifyProxyLocation;
  const configureFetchProxy = options.configureFetchProxy || configureGlobalFetchProxy;
  let proxyUrl = null;
  let initPromise = null;
  let status = {
    ready: false,
    configured: false,
    locationVerified: false,
    country: null,
    city: null,
    region: null,
    warning: null,
    error: null
  };

  function initialize() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        proxyUrl = parseProxyUrl(env.PROXY_URL);
        // Route Node global fetch (including license-authority and GitHub fork checks)
        // through the same proxy before any external request can run.
        configureFetchProxy(proxyUrl);
        status = { ...status, configured: true, ready: true, error: null };
        logger.log("[PROXY] Messenger HTTP/HTTPS and MQTT WebSocket traffic will use PROXY_URL.");
      } catch (error) {
        status = { ...status, ready: false, configured: false, error: error.message };
        logger.error("[PROXY] " + error.message);
        return getStatus();
      }

      // Startup-only check through the configured proxy. An ipinfo outage
      // never causes a direct-connection fallback.
      try {
        const location = await verifyLocation(proxyUrl);
        if (!location?.ok) {
          status.warning = "Could not verify proxy egress location through ipinfo.io (" + String(location?.error || "unknown_error") + "). Proxy-only mode remains enforced.";
          logger.warn("[PROXY] " + status.warning);
        } else {
          status.locationVerified = true;
          status.country = location.country || null;
          status.city = location.city || null;
          status.region = location.region || null;

          const isPhilippines = String(location.country || "").toUpperCase() === "PH";
          const isManila = String(location.city || "").trim().toLowerCase() === "manila";
          if (!isPhilippines || !isManila) {
            status.warning = "Proxy egress is reported as " +
              [location.city, location.region, location.country].filter(Boolean).join(", ") +
              "; expected Manila, Philippines. Proxy-only mode remains enforced.";
            logger.warn("[PROXY] " + status.warning);
          } else {
            logger.log("[PROXY] Egress location verified: Manila, Philippines.");
          }
        }
      } catch (_) {
        status.warning = "Proxy egress location check failed. Proxy-only mode remains enforced.";
        logger.warn("[PROXY] " + status.warning);
      }

      return getStatus();
    })();

    return initPromise;
  }

  function getStatus() {
    return { ...status };
  }

  function getLoginOptions() {
    if (!status.ready || !proxyUrl) {
      throw new Error(status.error || "Proxy is not ready; Messenger login is blocked.");
    }
    return { proxy: proxyUrl };
  }

  return { initialize, getStatus, getLoginOptions };
}

module.exports = { createProxyManager, parseProxyUrl, verifyProxyLocation, configureGlobalFetchProxy };
