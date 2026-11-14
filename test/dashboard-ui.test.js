"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");

test("ECLIPSE dashboard navigation points to real panels and inline script parses",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
  assert.ok(script,"dashboard inline script exists");
  assert.doesNotThrow(()=>new vm.Script(script));
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
  const navTargets=[...html.matchAll(/href="#([^"]+)"/g)].map(match=>match[1]);
  assert.ok(navTargets.length>=10,"desktop and mobile navigation links exist");
  for(const target of navTargets) assert.ok(ids.has(target),"navigation target exists: "+target);
  assert.match(html,/--bg:#07080b/);
  assert.match(html,/--accent:#c75a6a/);
  assert.match(html,/ECLIPSE Test Bot/);
});

test("dashboard management key is available globally rather than hidden inside Raid Mode",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  const access=html.indexOf('class="dashboard-access"');
  const raid=html.indexOf('id="raidModePanel"');
  assert.ok(access>=0 && raid>access,"global dashboard access panel appears before feature modules");
  assert.match(html,/id="raidApiKey"/);
  assert.match(html,/id="unlockDashboard"/);
  assert.match(html,/id="clearDashboardKey"/);
  assert.match(html,/async function unlockDashboard\(\)/);
  assert.match(html,/X-ECLIPSE-DASHBOARD-KEY/);
  assert.match(html,/const ownerKey=\$\("raidApiKey"\)\?\.value\?\.trim\(\)/);
  assert.match(html,/ECLIPSE_DASHBOARD_API_KEY/);
});

test("dashboard parity navigation and appearance controls are available on desktop and mobile",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  assert.match(html,/COMMAND CENTER/);
  assert.match(html,/BOT MANAGEMENT/);
  assert.match(html,/SYSTEM/);
  assert.match(html,/id="appearancePanel"/);
  assert.match(html,/data-theme="burgundy"/);
  assert.match(html,/data-theme="cyan"/);
  assert.match(html,/data-theme="gold"/);
  assert.match(html,/id="customAccent"/);
  assert.match(html,/id="applyCustomAccent"/);
  assert.match(html,/href="#appearancePanel"><span>◐<\/span>Theme<\/a>/);
  assert.match(html,/localStorage\.setItem\("eclipse-testbot-accent"/);
  assert.doesNotMatch(html,/(?:localStorage|sessionStorage)\.setItem\([^)]*(?:raidApiKey|DASHBOARD_API_KEY)/i);
});

test("activity center supports local search and event-type filtering",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  for(const id of ["eventSearch","eventType","clearEventFilters","eventCount","events"]) assert.ok(html.includes('id="'+id+'"'));
  assert.ok(html.includes("function renderEvents()"));
  assert.ok(html.includes('addEventListener("input",renderEvents)'));
});
test("dashboard feature modules each occupy their own full-width row",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  assert.match(html,/main\.wrap > \.grid > \.card:not\(#overview\):not\(#runtimePanel\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*!important/s);
  assert.match(html,/@media \(max-width: 850px\)[\s\S]*?main\.wrap > \.grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test("dashboard exposes seconds-based reply delay and bounded Spam Mode controls",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  assert.match(html,/Reply delay seconds/);
  assert.match(html,/Number\(\$\("groupReplyDelay"\)\.value\)\*1000/);
  for(const id of ["spamMessage","spamInterval","spamMaxMessages","spamStart","spamStop","spamRefresh","spamStatus"]) assert.ok(html.includes('id="'+id+'"'),"Spam Mode control exists: "+id);
  assert.match(html,/intervalSeconds<6/);
  assert.match(html,/maxMessages>100/);
  assert.match(html,/It will send up to/);
});
