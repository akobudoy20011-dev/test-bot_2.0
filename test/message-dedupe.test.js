"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isDuplicateMessage, resetProcessedMessages, MAX_PROCESSED_MESSAGE_IDS } = require("../message-dedupe");

test("detects repeated message IDs but accepts distinct IDs", () => {
  resetProcessedMessages();
  assert.equal(isDuplicateMessage("message-1"), false);
  assert.equal(isDuplicateMessage("message-2"), false);
  assert.equal(isDuplicateMessage("message-1"), true);
});

test("does not suppress events that have no message ID", () => {
  resetProcessedMessages();
  assert.equal(isDuplicateMessage(undefined), false);
  assert.equal(isDuplicateMessage(null), false);
  assert.equal(isDuplicateMessage(""), false);
});

test("bounds the cache and permits an evicted ID again", () => {
  resetProcessedMessages();
  for (let i = 0; i < MAX_PROCESSED_MESSAGE_IDS; i++) {
    assert.equal(isDuplicateMessage("id-" + i), false);
  }
  assert.equal(isDuplicateMessage("overflow"), false);
  assert.equal(isDuplicateMessage("id-0"), false);
  assert.equal(isDuplicateMessage("overflow"), true);
});
