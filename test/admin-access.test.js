"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAdminIds, isBotAdmin } = require("../admin-access");

test("parses comma, semicolon, and whitespace separated admin IDs", () => {
  assert.deepEqual(parseAdminIds("123, 456;789\n123"), ["123", "456", "789"]);
});

test("only explicitly configured Messenger IDs are admins", () => {
  assert.equal(isBotAdmin("123", "123,456"), true);
  assert.equal(isBotAdmin("456", "123,456"), true);
  assert.equal(isBotAdmin("999", "123,456"), false);
  assert.equal(isBotAdmin("", "123,456"), false);
});

test("no configured admin IDs denies all state changes", () => {
  assert.deepEqual(parseAdminIds(""), []);
  assert.equal(isBotAdmin("123", ""), false);
});
