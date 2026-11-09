"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createReactionAudience}=require("../reaction-audience");

test("admin audience refreshes its cache after process startup and reuses it briefly",async()=>{
  let loads=0,now=1000;
  const audience=createReactionAudience({ttlMs:5000,now:()=>now,async getAdmins(_api,threadID){loads++;assert.equal(threadID,"group-1");return ["admin-1"]; }});
  assert.equal(await audience.isAllowed({targetMode:"admins"},{threadID:"group-1",senderID:"admin-1"}),true);
  assert.equal(await audience.isAllowed({targetMode:"admins"},{threadID:"group-1",senderID:"member-1"}),false);
  assert.equal(loads,1);
  now+=5001;
  assert.equal(await audience.isAllowed({targetMode:"admins"},{threadID:"group-1",senderID:"admin-1"}),true);
  assert.equal(loads,2);
});

test("admin cache coalesces concurrent refreshes and can be invalidated",async()=>{
  let loads=0,release;
  const audience=createReactionAudience({getAdmins(){loads++;return new Promise(resolve=>{release=resolve;});}});
  const a=audience.isAllowed({targetMode:"admins"},{threadID:"g",senderID:"a"});
  const b=audience.isAllowed({targetMode:"admins"},{threadID:"g",senderID:"a"});
  await Promise.resolve();
  assert.equal(loads,1);
  release(["a"]);
  assert.equal(await a,true);
  assert.equal(await b,true);
  audience.invalidate("g");
  const c=audience.isAllowed({targetMode:"admins"},{threadID:"g",senderID:"a"});
  await Promise.resolve();
  assert.equal(loads,2);
  release(["a"]);
  assert.equal(await c,true);
});

test("member audience requires the exact configured group and Messenger ID",async()=>{
  const audience=createReactionAudience();
  const settings={targetMode:"member",targetThreadID:"group-1",targetUserId:"user-1"};
  assert.equal(await audience.isAllowed(settings,{threadID:"group-1",senderID:"user-1"}),true);
  assert.equal(await audience.isAllowed(settings,{threadID:"group-2",senderID:"user-1"}),false);
  assert.equal(await audience.isAllowed(settings,{threadID:"group-1",senderID:"user-2"}),false);
  assert.equal(await audience.isAllowed({targetMode:"member",targetUserId:"user-1"},{threadID:"group-1",senderID:"user-1"}),false);
});

test("admin lookup failures fail closed",async()=>{
  const audience=createReactionAudience({async getAdmins(){throw new Error("offline");}});
  assert.equal(await audience.isAllowed({targetMode:"admins"},{threadID:"g",senderID:"admin"}),false);
});

test("custom reaction target validation rejects incomplete dashboard saves",()=>{
  const {validateReactionTarget}=require("../reaction-audience");
  assert.throws(()=>validateReactionTarget({targetMode:"member",targetThreadID:"group-1"}),/group and a custom reaction target/);
  assert.throws(()=>validateReactionTarget({targetMode:"member",targetUserId:"user-1"}),/group and a custom reaction target/);
  assert.deepEqual(validateReactionTarget({targetMode:"member",targetThreadID:"group-1",targetUserId:"user-1"}),{targetMode:"member",targetThreadID:"group-1",targetUserId:"user-1"});
});
