"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {isTimeCheck,formatTimeCheck}=require("../time-check");
test("Time Check recognizes command and formats Manila time without seconds",()=>{
 assert.equal(isTimeCheck("time check"),true);assert.equal(isTimeCheck("TIME CHECK!"),true);assert.equal(isTimeCheck("time"),false);assert.equal(isTimeCheck("time check now"),false);
 assert.equal(formatTimeCheck(new Date("2026-11-19T02:00:00Z")),"time check: 10:00");
});
