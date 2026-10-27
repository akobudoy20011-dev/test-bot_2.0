"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isOwner } = require("../owner-access");

test("owner access only accepts an exact configured sender ID", () => {
  assert.equal(isOwner("12345", "12345"), true);
  assert.equal(isOwner("123456", "12345"), false);
  assert.equal(isOwner("12345", "99999"), false);
});

test("owner access fails closed when owner ID or sender ID is missing", () => {
  assert.equal(isOwner("12345", ""), false);
  assert.equal(isOwner("", "12345"), false);
  assert.equal(isOwner(null, "12345"), false);
  assert.equal(isOwner("12345", null), false);
});
