"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");

test("ECLIPSE dashboard navigation points to real panels and inline script parses",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  const script=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].at(-1)?.[1];
  assert.ok(script,"dashboard inline script exists");
  assert.doesNotThrow(()=>new vm.Script(script));
  const ids=new Set([...html.matchAll(/\\bid="([^"]+)"/g)].map(match=>match[1]));
  const navTargets=[...html.matchAll(/href="#([^"]+)"/g)].map(match=>match[1]);
  assert.ok(navTargets.length>=10,"desktop and mobile navigation links exist");
  for(const target of navTargets) assert.ok(ids.has(target),"navigation target exists: "+target);
  assert.match(html,/--bg:#07080b/);
  assert.match(html,/--accent:#c75a6a/);
  assert.match(html,/ECLIPSE Test Bot/);
});
