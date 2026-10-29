"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getBanatConversationReply } = require("../triggers");

test("active Banat produces a roast for ordinary messages without a configured target", () => {
  const threadID = "continuous-banat-test-" + process.pid;

  for (let i = 0; i < 250; i += 1) {
    const body = "ordinary group chat message number " + i + " xyz";
    const reply = getBanatConversationReply(body, threadID);
    assert.equal(typeof reply, "string", "reply " + i + " should be a string");
    assert.ok(reply.trim().length > 0, "reply " + i + " should not be empty");
  }
});
