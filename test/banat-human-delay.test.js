"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveReplyDelayMs } = require("../banat-human");

test("dashboard reply delay is interpreted as milliseconds after seconds conversion", () => {
  assert.equal(resolveReplyDelayMs(5000, 900), 5000);
  assert.equal(resolveReplyDelayMs(10000, 900), 10000);
});

test("empty dashboard delay uses humanized fallback and zero is not mistaken for missing", () => {
  assert.equal(resolveReplyDelayMs(null, 900), 900);
  assert.equal(resolveReplyDelayMs(0, 900), 120);
});
