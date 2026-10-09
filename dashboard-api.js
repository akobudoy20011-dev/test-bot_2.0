"use strict";
const http = require("http");
module.exports = function startDashboardApi(port, getStatus, setPaused) {
  const key = String(process.env.ECLIPSE_DASHBOARD_API_KEY || "").trim();
  const origin = process.env.ECLIPSE_DASHBOARD_ORIGIN || "*";
  const events = [];
  const send = (res, code, body) => { res.writeHead(code, {"Content-Type":"application/json","Cache-Control":"no-store"}); res.end(JSON.stringify(body)); };
  const server = http.createServer((req,res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ECLIPSE-DASHBOARD-KEY");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/health") return send(res,200,{ok:true,service:"banat-only",dashboard_api:Boolean(key)});
    if (!url.pathname.startsWith("/api/dashboard/")) return send(res,404,{ok:false,error:"Not found"});
    if (!key) return send(res,503,{ok:false,error:"Set ECLIPSE_DASHBOARD_API_KEY on this service"});
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\\s+/i,"").trim();
    if (String(req.headers["x-eclipse-dashboard-key"] || bearer) !== key) return send(res,401,{ok:false,error:"Dashboard authorization required"});
    if (req.method === "GET" && url.pathname === "/api/dashboard/status") return send(res,200,getStatus());
    if (req.method === "GET" && url.pathname === "/api/dashboard/snapshot") return send(res,200,{ok:true,snapshot:null,runtime:{watchdog:{ok:true},traffic:{},music:{},database:null,uptime_seconds:Math.floor(process.uptime()),node_version:process.version,memory:process.memoryUsage()},degraded:true});
    if (req.method === "GET" && url.pathname === "/api/dashboard/health") return send(res,200,{ok:true,runtime:{watchdog:{ok:true},traffic:{},music:{},database:null,uptime_seconds:Math.floor(process.uptime()),node_version:process.version,memory:process.memoryUsage()}});
    if (req.method === "GET" && url.pathname === "/api/dashboard/events") return send(res,200,{ok:true,events:events.slice(0,80)});
    if (req.method === "GET" && url.pathname === "/api/dashboard/analytics") return send(res,200,{ok:true,analytics:{generated_at:new Date().toISOString(),hours:24,economy:[],rpg:[],battles:[],moderation:[]}});
    if (req.method === "GET" && url.pathname === "/api/dashboard/user") return send(res,200,{ok:true,inspector:{generated_at:new Date().toISOString(),user:null,rpg:null,inventory:[],equipment:[],skills:[],spells:[],pets:[],transactions:[],moderation:[]}});
    if (req.method === "POST" && /\\/api\\/dashboard\\/bot\\/(start|stop)$/.test(url.pathname)) { const paused=url.pathname.endsWith("/stop"); setPaused(paused); events.unshift({id:String(Date.now()),type:"bot",message:paused?"Bot paused from dashboard":"Bot resumed from dashboard",meta:{},created_at:new Date().toISOString()}); return send(res,200,{ok:true,action:paused?"bot_paused":"bot_start_requested"}); }
    if (req.method === "POST" && url.pathname === "/api/dashboard/disconnect") { setPaused(true); return send(res,200,{ok:true,action:"bot_paused",note:"Replies paused; session not revoked"}); }
    if (req.method === "POST" && url.pathname === "/api/dashboard/reconnect") return send(res,409,{ok:false,error:"Configure the Facebook session in service environment and restart"});
    if (req.method === "POST" && url.pathname === "/api/dashboard/connect-session") return send(res,501,{ok:false,error:"Session upload is not supported; configure the Facebook session in service environment and restart"});
    return send(res,404,{ok:false,error:"Unsupported dashboard endpoint"});
  });
  server.listen(port,()=>console.log("[BANAT] health + dashboard API server :"+port));
  return server;
};
