"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyBanatTarget,
  setBanatConversationMode,
} = require("../banat-targeting");

test("recognizes a reply to the bot when the caller supplies eclipseUserID", () => {
  const result = classifyBanatTarget({
    event: { threadID: "thread-1", messageReply: { senderID: "bot-123" } },
    body: "what do you mean?",
    eclipseUserID: "bot-123",
  });
  assert.equal(result.shouldRespond, true);
  assert.equal(result.via, "reply");
  assert.equal(result.replyToBot, true);
});

test("recognizes a mention of the bot", () => {
  const result = classifyBanatTarget({
    event: { threadID: "thread-2", mentions: { "bot-123": "Bot" } },
    body: "hey",
    eclipseUserID: "bot-123",
  });
  assert.equal(result.shouldRespond, true);
  assert.equal(result.via, "mention");
  assert.equal(result.mentionedBot, true);
});

test("does not respond to an undirected question when conversation mode is off", () => {
  const result = classifyBanatTarget({
    event: { threadID: "thread-3" },
    body: "why did that happen?",
    eclipseUserID: "bot-123",
  });
  assert.equal(result.shouldRespond, false);
  assert.equal(result.reason, "question-not-directed-to-eclipse");
});

test("responds while explicit conversation mode is active", () => {
  setBanatConversationMode("thread-4", true, "user-1");
  const result = classifyBanatTarget({
    event: { threadID: "thread-4" },
    body: "ok then",
    eclipseUserID: "bot-123",
  });
  assert.equal(result.shouldRespond, true);
  assert.equal(result.via, "conversation");
  setBanatConversationMode("thread-4", false);
});
