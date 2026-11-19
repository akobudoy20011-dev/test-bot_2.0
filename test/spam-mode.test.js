"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSpamMode, formatSpamMessage, parseSpamInput, MAX_MESSAGES } = require("../spam-mode");

test("Spam Mode requires a valid group, custom message, and interval of at least two seconds", () => {
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 1 }), /between 2 and 3600/);
  assert.throws(() => spam.start({ threadID: "g", message: "hello", intervalSeconds: 3601 }), /between 2 and 3600/);
  assert.throws(() => spam.start({ threadID: "", message: "hello", intervalSeconds: 2 }), /valid Messenger group/);
  assert.throws(() => spam.start({ threadID: "g", message: "", intervalSeconds: 2 }), /list between 1 and 1,000,000 characters/);
});

test("Spam Mode sends insult text without numbered input markers", () => {
  assert.equal(formatSpamMessage("moka ka tanga jan", 1), "moka ka tanga jan");
  assert.equal(formatSpamMessage("  wala na  ", 2), "wala na");
  assert.equal(formatSpamMessage("moka ka tanga jan", 1000), "moka ka tanga jan");
  assert.equal(MAX_MESSAGES, 1000);
});

test("compact numbered entries are parsed as separate ordered messages", () => {
  assert.deepEqual(parseSpamInput("1. lah 2. oo 3. sige"), {
    mode: "sequence",
    messages: ["lah", "oo", "sige"]
  });
});

test("newline numbered entries are parsed as separate ordered messages", () => {
  assert.deepEqual(parseSpamInput("1. lah\n2. oo\n3. sige"), {
    mode: "sequence",
    messages: ["lah", "oo", "sige"]
  });
});

test("numbered template skips unfilled lines and preserves the filled order", () => {
  assert.deepEqual(parseSpamInput(["1. lah", "2. ", "3. sige", "4. ", "5. tara"].join("\n")), {
    mode: "sequence",
    messages: ["lah", "sige", "tara"]
  });
  assert.deepEqual(parseSpamInput(["1. ", "2. ", "3. ", "4. ", "5. "].join("\n")), {
    mode: "sequence",
    messages: []
  });
});

test("numbered list supports 1000 entries and rejects more than 1000", () => {
  const thousand = Array.from({ length: 1000 }, (_, index) => (index + 1) + ". banat " + (index + 1)).join("\n");
  const parsed = parseSpamInput(thousand);
  assert.equal(parsed.mode, "sequence");
  assert.equal(parsed.messages.length, 1000);
  assert.equal(parsed.messages[0], "banat 1");
  assert.equal(parsed.messages[999], "banat 1000");
  const overLimit = Array.from({ length: 1001 }, (_, index) => (index + 1) + ". banat").join("\n");
  assert.throws(() => createSpamMode({ getApi: () => ({}), sendMessage: async () => {} }).start({
    threadID: "group-over-limit", message: overLimit, intervalSeconds: 2
  }), /limited to 1000 numbered lines/);
  const tooManyPlaceholders = Array.from({ length: 1001 }, (_, index) => (index + 1) + ". ").join("\n");
  assert.throws(() => createSpamMode({ getApi: () => ({}), sendMessage: async () => {} }).start({
    threadID: "group-too-many-lines", message: tooManyPlaceholders, intervalSeconds: 2
  }), /limited to 1000 numbered lines/);
});

test("plain multiline entries are sent as a finite sequence", () => {
  assert.deepEqual(parseSpamInput("lah\noo\nsige"), {
    mode: "sequence",
    messages: ["lah", "oo", "sige"]
  });
});

test("single message keeps the existing repeat-to-1000 behavior", () => {
  assert.deepEqual(parseSpamInput("custom words"), {
    mode: "repeat",
    messages: ["custom words"]
  });
});

test("Spam Mode sequence reports its finite message count and can be stopped", async () => {
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  const started = spam.start({ threadID: "group-1", message: "1. lah 2. oo 3. sige", intervalSeconds: 2 });
  assert.equal(started.firstSendInSeconds, 2);
  assert.equal(started.numbered, true);
  assert.equal(started.mode, "sequence");
  assert.equal(started.totalMessages, 3);
  assert.equal(spam.getStatus()[0].totalMessages, 3);
  assert.equal(spam.getStatus()[0].sent, 0);
  assert.equal(spam.stop("group-1").stopped, true);
  assert.deepEqual(spam.getStatus(), []);
});

test("numbered list sends one entry per tick in order and stops at the end", async () => {
  const timers = [];
  const sent = [];
  const spam = createSpamMode({
    getApi: () => ({}),
    sendMessage: async (_api, message) => { sent.push(message); },
    isAuthorized: () => true,
    setTimeoutFn: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutFn: () => {}
  });
  const started = spam.start({ threadID: "group-list", message: "1. lah 2. oo 3. sige", intervalSeconds: 2 });
  assert.equal(started.totalMessages, 3);
  // Capture and execute the first delayed send, then each scheduled next send.

  assert.equal(sent.length, 0);
  assert.equal(timers.length, 1);
  await timers.shift().fn();
  assert.deepEqual(sent, ["lah"]);
  assert.equal(spam.getStatus()[0].sent, 1);
  await timers.shift().fn();
  assert.deepEqual(sent, ["lah", "oo"]);
  await timers.shift().fn();
  assert.deepEqual(sent, ["lah", "oo", "sige"]);
  assert.deepEqual(spam.getStatus(), []);
});

test("Spam Mode single message waits before first send and can be stopped", async () => {
  let sends = 0;
  const spam = createSpamMode({ getApi: () => ({}), sendMessage: async () => { sends++; }, isAuthorized: () => true });
  const started = spam.start({ threadID: "group-2", message: "custom words", intervalSeconds: 2 });
  assert.equal(started.firstSendInSeconds, 2);
  assert.equal(started.mode, "repeat");
  assert.equal(started.totalMessages, 1000);
  assert.equal(sends, 0);
  assert.equal(spam.getStatus()[0].intervalSeconds, 2);
  assert.equal(spam.getStatus()[0].totalMessages, 1000);
  const stopped = spam.stop("group-2");
  assert.equal(stopped.stopped, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sends, 0);
  assert.deepEqual(spam.getStatus(), []);
});

test("Spam Mode rejects duplicate runs and unauthorized starts", () => {
  const denied = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => false });
  assert.throws(() => denied.start({ threadID: "g", message: "hello", intervalSeconds: 2 }), /must be connected/);
  const allowed = createSpamMode({ getApi: () => ({}), sendMessage: async () => {}, isAuthorized: () => true });
  allowed.start({ threadID: "g", message: "hello", intervalSeconds: 2 });
  assert.throws(() => allowed.start({ threadID: "g", message: "again", intervalSeconds: 2 }), /already running/);
  allowed.stopAll("test");
});

test("sequence looping is bounded by loop count and the 1000-send ceiling",()=>{
 const spam=createSpamMode({getApi:()=>({}),sendMessage:async()=>{},isAuthorized:()=>true});
 const run=spam.start({threadID:"loop-test",message:"1. hi 2. bye",intervalSeconds:2,loops:3});
 assert.equal(run.loops,3);assert.equal(run.totalMessages,6);spam.stop("loop-test");
 assert.throws(()=>spam.start({threadID:"over-loop",message:"1. a 2. b 3. c 4. d 5. e 6. f 7. g 8. h 9. i 10. j 11. k",intervalSeconds:2,loops:100}),/1000-message safety limit/);
 assert.throws(()=>spam.start({threadID:"bad-loop",message:"1. a 2. b",intervalSeconds:2,loops:101}),/between 1 and 100/);
});

test("looped sequence sends each entry in order for each bounded loop",async()=>{
 const timers=[],sent=[];
 const spam=createSpamMode({getApi:()=>({}),sendMessage:async(_api,msg)=>sent.push(msg),isAuthorized:()=>true,setTimeoutFn:(fn,delay)=>{const timer={fn,delay,unref(){}};timers.push(timer);return timer;},clearTimeoutFn:()=>{}});
 spam.start({threadID:"loop-run",message:"1. A 2. B",intervalSeconds:2,loops:2});
 while(timers.length){await timers.shift().fn();}
 assert.deepEqual(sent,["A","B","A","B"]);assert.deepEqual(spam.getStatus(),[]);
});
