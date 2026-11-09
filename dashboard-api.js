"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

module.exports = function startDashboardApi(port, getStatus, controls = {}) {
  const origin = String(process.env.ECLIPSE_DASHBOARD_ORIGIN || "*").trim();
  const allowedOrigins = origin.split(",").map(value => value.trim()).filter(Boolean);
  const events = [];
  const dashboardPath = path.join(__dirname, "dashboard.html");
  const licenseGuard = controls.licenseGuard || null;

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

  const readBuffer = (req, maxBytes) => new Promise((resolve,reject)=>{
    const chunks=[]; let size=0, settled=false;
    req.on("data",chunk=>{ if(settled)return; size+=chunk.length; if(size>maxBytes){settled=true;reject(new Error("Request body too large"));req.destroy();return;} chunks.push(chunk); });
    req.on("end",()=>{if(!settled){settled=true;resolve(Buffer.concat(chunks));}});
    req.on("error",error=>{if(!settled){settled=true;reject(error);}});
  });

  const readJson = (req) => new Promise((resolve,reject)=>{
    let raw="";
    req.on("data",chunk=>{raw+=chunk;if(raw.length>150*1024){reject(new Error("Request body too large"));req.destroy();}});
    req.on("end",()=>{if(!raw.trim())return resolve({});try{resolve(JSON.parse(raw));}catch(_){reject(new Error("Invalid JSON body"));}});
    req.on("error",reject);
  });

  const runtime = () => ({
    uptime_seconds: Math.floor(process.uptime()),
    node_version: process.version,
    memory: process.memoryUsage()
  });

  const server = http.createServer(async (req, res) => {
    const requestOrigin = String(req.headers.origin || "");
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const requestHost = String(req.headers.host || "").trim();
    const requestHostOrigin = requestHost
      ? (forwardedProto || "http") + "://" + requestHost
      : "";
    const originAllowed = origin === "*" || !requestOrigin ||
      allowedOrigins.includes(requestOrigin) || requestOrigin === requestHostOrigin;
    if (originAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin === "*" ? "*" : (requestOrigin || allowedOrigins[0] || origin));
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-ECLIPSE-DASHBOARD-KEY, X-File-Name");
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
      return send(res, 200, { ok: true, service: "banat-test-bot", dashboard_api: true });
    }

    if (req.method === "POST" && url.pathname === "/api/license/verify") {
      const requestId = String(req.headers["x-eclipse-request-id"] || ("license-" + Date.now())).slice(0, 100);
      const startedAt = Date.now();
      console.info("[ECLIPSE LICENSE API] Verification request received", {
        request_id: requestId,
        method: req.method,
        path: url.pathname
      });
      if (!licenseGuard || typeof licenseGuard.verifyIncomingInstallation !== "function") {
        console.warn("[ECLIPSE LICENSE API] Authority is not configured", { request_id: requestId });
        return send(res, 503, { ok: false, status: "unavailable", error: "License authority is not configured.", request_id: requestId });
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        console.warn("[ECLIPSE LICENSE API] Invalid verification request body", {
          request_id: requestId,
          error: String(error && error.message || error).slice(0, 200)
        });
        return send(res, 400, { ok: false, status: "invalid", error: "Invalid license verification request.", request_id: requestId });
      }
      try {
        const result = await licenseGuard.verifyIncomingInstallation(body);
        const statusCode = result.status === "approved" ? 200 : 403;
        console.info("[ECLIPSE LICENSE API] Verification completed", {
          request_id: requestId,
          result: result.status || "unknown",
          http_status: statusCode,
          elapsed_ms: Date.now() - startedAt
        });
        return send(res, statusCode, { ...result, request_id: requestId });
      } catch (error) {
        console.error("[ECLIPSE LICENSE API] Verification failed", {
          request_id: requestId,
          elapsed_ms: Date.now() - startedAt,
          error: String(error && error.stack || error).slice(0, 1200)
        });
        return send(res, 503, {
          ok: false,
          status: "unavailable",
          error: "The license authority could not complete verification.",
          request_id: requestId
        });
      }
    }

    if (!url.pathname.startsWith("/api/dashboard/")) {
      return send(res, 404, { ok: false, error: "Not found" });
    }

    const securityRoute = url.pathname.startsWith("/api/dashboard/security/");
    const raidRoute = url.pathname.startsWith("/api/dashboard/raid/");
    if ((securityRoute || raidRoute) && (!licenseGuard || !licenseGuard.dashboardAuthorized(req))) {
      return send(res, 401, { ok: false, error: "Valid X-ECLIPSE-DASHBOARD-KEY required for this management action." });
    }

    if (!originAllowed) {
      console.warn("[BANAT] dashboard origin rejected", {
        requestOrigin,
        configuredOrigin: origin,
        requestHostOrigin
      });
      return send(res, 403, { ok: false, error: "Dashboard origin not allowed" });
    }

    const publicDashboardRead = req.method === "GET" && [
      "/api/dashboard/status", "/api/dashboard/health", "/api/dashboard/events"
    ].includes(url.pathname);
    const ownerManagedRoute = url.pathname.startsWith("/api/dashboard/") &&
      !publicDashboardRead && !url.pathname.startsWith("/api/dashboard/security/") &&
      !url.pathname.startsWith("/api/dashboard/raid/");
    if (ownerManagedRoute && (!licenseGuard || !licenseGuard.dashboardAuthorized(req))) {
      return send(res, 401, { ok: false, error: "Valid X-ECLIPSE-DASHBOARD-KEY required for dashboard management." });
    }

    if (url.pathname.startsWith("/api/dashboard/raid/")) {
      const raid = controls.raidMode;
      if (typeof controls.isLicensed === "function" && !controls.isLicensed()) return send(res, 403, { ok: false, error: "This installation is not authorized to manage Raid Mode." });
      if (!raid) return send(res, 503, { ok: false, error: "Raid Mode is not initialized." });
      try {
        if (req.method === "GET" && url.pathname === "/api/dashboard/raid/status") {
          return send(res, 200, { ok: true, raid: await raid.getStatus() });
        }
        if (req.method === "POST" && url.pathname === "/api/dashboard/raid/theme") {
          const body = await readJson(req);
          const theme = await raid.saveTheme(body);
          return send(res, 200, { ok: true, theme });
        }
        if (req.method === "POST" && url.pathname === "/api/dashboard/raid/theme-image") {
          const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          const fileName = String(req.headers["x-file-name"] || "raid-theme").slice(0, 120);
          const buffer = await readBuffer(req, 5 * 1024 * 1024);
          const image = await raid.uploadImage(buffer, contentType, fileName);
          return send(res, 200, { ok: true, image });
        }
        if (req.method === "GET" && url.pathname === "/api/dashboard/raid/theme-image") {
          const image = await raid.getImage();
          if (!image) return send(res, 404, { ok: false, error: "No Raid Mode theme image has been uploaded." });
          res.writeHead(200, { "Content-Type": image.contentType, "Content-Length": image.buffer.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
          return res.end(image.buffer);
        }
        if (req.method === "POST" && url.pathname === "/api/dashboard/raid/activate") {
          const body = await readJson(req);
          const result = await raid.activate(body);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && url.pathname === "/api/dashboard/raid/repair") {
          const body = await readJson(req);
          const result = await raid.repairGroup(body.threadID, "manual-repair");
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && url.pathname === "/api/dashboard/raid/emergency-stop") {
          const result = await raid.emergencyStop();
          return send(res, 200, { ok: true, result });
        }
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Raid Mode action failed." });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/security/status") {
      return send(res, 200, { ok: true, license: licenseGuard ? licenseGuard.getStatus() : null, mode: licenseGuard ? (licenseGuard.getStatus().mode) : "unavailable" });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/security/license-settings") {
      try { return send(res, 200, { ok: true, settings: await licenseGuard.getLicenseSettings() }); }
      catch (error) { return send(res, 503, { ok: false, error: error.message || "License settings unavailable." }); }
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/security/license-settings") {
      try {
        const body = await readJson(req);
        const settings = await licenseGuard.updateLicenseSettings(body);
        return send(res, 200, { ok: true, settings });
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Could not update license settings." });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/security/installations") {
      try { return send(res, 200, { ok: true, installations: await licenseGuard.listInstallations() }); }
      catch (error) { return send(res, 503, { ok: false, error: error.message || "Installation registry unavailable." }); }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/security/forks") {
      try { return send(res, 200, { ok: true, forks: await licenseGuard.listForks() }); }
      catch (error) { return send(res, 502, { ok: false, error: error.message || "GitHub fork lookup failed." }); }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/security/events") {
      try { return send(res, 200, { ok: true, events: await licenseGuard.listEvents() }); }
      catch (error) { return send(res, 503, { ok: false, error: error.message || "Security event history unavailable." }); }
    }
    const installationAction = url.pathname.match(new RegExp("^/api/dashboard/security/installations/([a-f0-9-]{32,64})/(approve|revoke)$", "i"));
    if (req.method === "POST" && installationAction) {
      try {
        const installation = await licenseGuard.updateInstallation(installationAction[1], installationAction[2] === "approve" ? "approved" : "revoked");
        return send(res, 200, { ok: true, installation });
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Could not update installation authorization." });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/session") {
      if (typeof controls.getSessionStatus !== "function") return send(res,501,{ok:false,error:"Session storage unavailable"});
      try { return send(res,200,{ok:true,session:controls.getSessionStatus()}); }
      catch(error) { return send(res,503,{ok:false,error:error.message||"Session status unavailable"}); }
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/session") {
      if (typeof controls.saveSession !== "function") return send(res,501,{ok:false,error:"Session storage unavailable"});
      try {
        const body=await readJson(req);
        controls.saveSession(body.cookie);
        record("session-validation-started",{storage:"memory"});
        return send(res,200,{ok:true,saved:true,validating:true,encrypted:false,restart_required:false,message:"Session accepted for validation. The existing connection is preserved unless the replacement successfully authenticates. Session memory is cleared on restart or spin-down."});
      } catch(error) { return send(res,400,{ok:false,error:error.message||"Could not save session"}); }
    }
    if (req.method === "DELETE" && url.pathname === "/api/dashboard/session") {
      if (typeof controls.clearSession !== "function") return send(res,501,{ok:false,error:"Session storage unavailable"});
      try { controls.clearSession(); record("session-cleared"); return send(res,200,{ok:true,cleared:true,restart_required:true}); }
      catch(error) { return send(res,500,{ok:false,error:"Could not clear saved session"}); }
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

    if (req.method === "GET" && url.pathname === "/api/dashboard/groups") {
      if (typeof controls.getGroups !== "function") return send(res, 501, { ok:false, error:"Messenger group list is unavailable" });
      try { return send(res,200,{ok:true,groups:await controls.getGroups()}); }
      catch(error){ record("group-list-failed",{error:String(error?.message||error).slice(0,250)}); return send(res,502,{ok:false,error:error?.message||"Could not load Messenger groups"}); }
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/setnn/mass") {
      if (typeof controls.massSetNickname !== "function") return send(res, 503, { ok: false, error: "Mass SetNN is unavailable." });
      if (typeof controls.isLicensed === "function" && !controls.isLicensed()) return send(res, 403, { ok: false, error: "This installation is not authorized." });
      try {
        const body = await readJson(req);
        const result = await controls.massSetNickname(body.threadID, body.userIDs, body.nickname);
        return send(res, 200, { ok: true, result });
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Mass SetNN failed." });
      }
    }

    const countdown = controls.countdown;
    if (url.pathname.startsWith("/api/dashboard/countdown/")) {
      if (!countdown) return send(res, 503, { ok: false, error: "Countdown controls are unavailable." });
      if (typeof controls.isLicensed === "function" && !controls.isLicensed()) return send(res, 403, { ok: false, error: "This installation is not authorized." });
      try {
        if (req.method === "GET" && url.pathname === "/api/dashboard/countdown/status") {
          return send(res, 200, { ok: true, active: countdown.getActive() });
        }
        if (req.method === "GET" && url.pathname === "/api/dashboard/countdown/history") {
          return send(res, 200, { ok: true, history: await countdown.getHistory() });
        }
        if (req.method === "GET" && url.pathname === "/api/dashboard/countdown/group") {
          const threadID = String(url.searchParams.get("threadID") || "").trim();
          if (!threadID) return send(res, 400, { ok: false, error: "A group is required." });
          return send(res, 200, { ok: true, group: await countdown.getGroup(threadID) });
        }
        if (req.method === "POST" && url.pathname === "/api/dashboard/countdown/group") {
          const body = await readJson(req);
          if (!body.threadID) return send(res, 400, { ok: false, error: "A group is required." });
          const group = await countdown.updateGroup(body.threadID, body);
          return send(res, 200, { ok: true, group });
        }
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message || "Countdown request failed." });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/group-members") {
      if (typeof controls.getGroupMembers !== "function") return send(res, 501, { ok: false, error: "Messenger member lookup is unavailable" });
      try {
        const threadID = String(url.searchParams.get("threadID") || "").trim();
        if (!threadID || threadID.length > 128) return send(res, 400, { ok: false, error: "A valid group is required." });
        const members = await controls.getGroupMembers(threadID);
        return send(res, 200, { ok: true, threadID, members });
      } catch (error) {
        return send(res, 502, { ok: false, error: error.message || "Could not load group members." });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/settings") {
      if (typeof controls.getSettings !== "function") return send(res,501,{ok:false,error:"Settings unavailable"});
      return send(res,200,{ok:true,settings:await controls.getSettings()});
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/settings/reaction") {
      if (typeof controls.updateReaction !== "function") return send(res,501,{ok:false,error:"Reaction settings unavailable"});
      try { const body=await readJson(req); const reaction=await controls.updateReaction(body); record("reaction-settings-updated",{enabled:reaction.enabled,target:reaction.target,targetMode:reaction.targetMode}); return send(res,200,{ok:true,reaction}); }
      catch(error){return send(res,400,{ok:false,error:error.message||"Could not save reaction settings"});}
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/settings/group") {
      if (typeof controls.updateGroup !== "function") return send(res,501,{ok:false,error:"Group settings unavailable"});
      try { const body=await readJson(req); const group=controls.updateGroup(body.threadID,body); record("group-settings-updated",{thread_id:group.threadID,banat_mode:group.banatMode}); return send(res,200,{ok:true,group}); }
      catch(error){return send(res,400,{ok:false,error:error.message||"Could not save group settings"});}
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
