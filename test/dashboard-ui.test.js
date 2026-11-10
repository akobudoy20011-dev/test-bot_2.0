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

test("dashboard feature modules each occupy their own full-width row",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","dashboard.html"),"utf8");
  assert.match(html,/main\.wrap > \.grid > \.card:not\(#overview\):not\(#runtimePanel\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*!important/s);
  assert.match(html,/@media \(max-width: 850px\)[\s\S]*?main\.wrap > \.grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});
