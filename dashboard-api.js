"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

module.exports = function startDashboardApi(port, getStatus, controls = {}) {
  const key = String(process.env.ECLIPSE_DASHBOARD_API_KEY || "").trim();
  const origin = String(process.env.ECLIPSE_DASHBOARD_ORIGIN || "*").trim();
  const events = [];
  const dashboardPath = path.join(__dirname, "dashboard.html");

  const send = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(JSON.stringify(body));
  };

  const record = (type, details = {}) => {
    events.unshift({ at: new Date().toISOString(), type, ...details });
    if (events.length > 80) events.length = 80;
  };
  if (typeof controls.setRecordEvent === "function") controls.setRecordEvent(record);

  const readJson = (req) => new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 16384) { reject(new Error("Request body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });

  const authorized = (req) => {
    if (!key) return false;
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const supplied = String(req.headers["x-eclipse-dashboard-key"] || bearer).trim();
    const a = Buffer.from(supplied);
    const b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const runtime = () => ({
    uptime_seconds: Math.floor(process.uptime()),
    node_version: process.version,
    memory: process.memoryUsage()
  });

  const server = http.createServer(async (req, res) => {
    const requestOrigin = String(req.headers.origin || "");
    if (origin === "*" || !requestOrigin || requestOrigin === origin) {
      res.setHeader("Access-Control-Allow-Origin", origin === "*" ? "*" : origin);
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Eclipse-Dashboard-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/dashboard.html")) {
      if (!fs.existsSync(dashboardPath)) return send(res, 500, { ok: false, error: "Dashboard file is missing" });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      return fs.createReadStream(dashboardPath).pipe(res);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "banat-test-bot", dashboard_api: Boolean(key) });
    }

    if (!url.pathname.startsWith("/api/dashboard/")) {
      return send(res, 404, { ok: false, error: "Not found" });
    }

    if (!key) {
      return send(res, 503, { ok: false, error: "Set ECLIPSE_DASHBOARD_API_KEY on this service" });
    }
    if (!authorized(req)) {
      return send(res, 401, { ok: false, error: "Dashboard authorization required" });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/status") {
      const status = typeof getStatus === "function" ? getStatus() : {};
      return send(res, 200, {
        ...status,
        ...runtime(),
        bot_paused: typeof controls.getPaused === "function" ? Boolean(controls.getPaused()) : false
      });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/health") {
      return send(res, 200, { ok: true, runtime: runtime() });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/events") {
      return send(res, 200, { ok: true, events: events.slice(0, 80) });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/settings") {
      if (typeof controls.getSettings !== "function") return send(res, 501, { ok: false, error: "Settings are unavailable" });
      return send(res, 200, { ok: true, settings: controls.getSettings() });
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard/settings/reaction") {
      if (typeof controls.updateReaction !== "function") return send(res, 501, { ok: false, error: "Reaction settings are unavailable" });
      try {
        const body = await readJson(req);
        const reaction = controls.updateReaction(body);
        record("reaction-settings-updated", { target: reaction.target, enabled: reaction.enabled });
        return send(res, 200, { ok: true, reaction });
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Could not save reaction settings" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard/settings/group") {
      if (typeof controls.updateGroup !== "function") return send(res, 501, { ok: false, error: "Group settings are unavailable" });
      try {
        const body = await readJson(req);
        const group = controls.updateGroup(body.threadID, body);
        record("group-settings-updated", { thread_id: group.threadID, banat_mode: group.banatMode });
        return send(res, 200, { ok: true, group });
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Could not save group settings" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard/bot/start") {
      if (typeof controls.setPaused !== "function") return send(res, 501, { ok: false, error: "Bot start control is unavailable" });
      controls.setPaused(false);
      record("bot-resumed");
      return send(res, 200, { ok: true, bot_paused: false });
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard/bot/stop") {
      if (typeof controls.setPaused !== "function") return send(res, 501, { ok: false, error: "Bot pause control is unavailable" });
      controls.setPaused(true);
      record("bot-paused");
      return send(res, 200, { ok: true, bot_paused: true });
    }

    if (req.method === "POST" && [
      "/api/dashboard/connect-session",
      "/api/dashboard/reconnect",
      "/api/dashboard/disconnect"
    ].includes(url.pathname)) {
      return send(res, 501, { ok: false, error: "Session management is environment-based in this test edition. Update the host environment and restart the service." });
    }

    return send(res, 404, { ok: false, error: "Unsupported dashboard endpoint" });
  });

  server.listen(port, () => console.log("[BANAT] dashboard + API listening on :" + port));
  return server;
};
