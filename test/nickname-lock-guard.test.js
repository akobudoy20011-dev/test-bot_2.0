"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createNicknameLockGuard}=require("../nickname-lock-guard");

test("nickname guard restores a saved nickname after a nickname-change event",async()=>{
  const calls=[];
  const store={isInitialized:()=>true,async getNicknameLocks(){return [{threadID:"g",userID:"u1",expectedNickname:"Locked name"}];},async deleteNicknameLock(){},async listNicknameLocks(){return [];}};
  const api={getThreadInfo(_id,cb){cb(null,{participantIDs:["u1"],nicknames:{u1:"Changed name"}});},changeNickname(name,thread,user,cb){calls.push({name,thread,user});cb(null);}};
  const guard=createNicknameLockGuard({store,getApi:()=>api});
  await guard.handleEvent({threadID:"g",logMessageType:"log:thread-nickname",logMessageData:{participant_id:"u1"}});
  assert.deepEqual(calls,[{name:"Locked name",thread:"g",user:"u1"}]);
  guard.stop();
});

test("nickname guard removes locks for members who left the group",async()=>{
  const deleted=[];
  const store={isInitialized:()=>true,async getNicknameLocks(){return [{threadID:"g",userID:"gone",expectedNickname:"Name"}];},async deleteNicknameLock(thread,user){deleted.push([thread,user]);},async listNicknameLocks(){return [];}};
  const api={getThreadInfo(_id,cb){cb(null,{participantIDs:["still-here"],nicknames:{}});}};
  const guard=createNicknameLockGuard({store,getApi:()=>api});
  await guard.restoreGroup("g","test","gone");
  assert.deepEqual(deleted,[["g","gone"]]);
  guard.stop();
});

test("nickname guard does not overwrite nicknames when Messenger does not expose current values",async()=>{
  let changed=0;
  const store={isInitialized:()=>true,async getNicknameLocks(){return [{threadID:"g",userID:"u1",expectedNickname:"Locked name"}];},async deleteNicknameLock(){},async listNicknameLocks(){return [];}};
  const api={getThreadInfo(_id,cb){cb(null,{participantIDs:["u1"]});},changeNickname(){changed++;}};
  const guard=createNicknameLockGuard({store,getApi:()=>api});
  await guard.restoreGroup("g","test");
  assert.equal(changed,0);
  guard.stop();
});

test("nickname guard ignores its own restoration event once the expected nickname is present",async()=>{
  let changed=0;
  const store={isInitialized:()=>true,async getNicknameLocks(){return [{threadID:"g",userID:"u1",expectedNickname:"Locked name"}];},async deleteNicknameLock(){},async listNicknameLocks(){return [];}};
  const api={getThreadInfo(_id,cb){cb(null,{participantIDs:["u1"],nicknames:{u1:"Locked name"}});},changeNickname(){changed++;}};
  const guard=createNicknameLockGuard({store,getApi:()=>api});
  await guard.handleEvent({threadID:"g",logMessageType:"log:thread-nickname",logMessageData:{participant_id:"u1"}});
  assert.equal(changed,0);
  guard.stop();
});

test("nickname guard restores saved values once on reconnect even if current values are unavailable",async()=>{
  const changed=[];
  const store={isInitialized:()=>true,async getNicknameLocks(){return [{threadID:"g",userID:"u1",expectedNickname:"One"},{threadID:"g",userID:"u2",expectedNickname:"Two"}];},async deleteNicknameLock(){},async listNicknameLocks(){return [{threadID:"g",userID:"u1"},{threadID:"g",userID:"u2"}];}};
  const api={getThreadInfo(_id,cb){cb(null,{participantIDs:["u1","u2"]});},changeNickname(name,thread,user,cb){changed.push({name,thread,user});cb(null);}};
  const guard=createNicknameLockGuard({store,getApi:()=>api});
  await guard.reconcile("reconnect");
  assert.deepEqual(changed,[{name:"One",thread:"g",user:"u1"},{name:"Two",thread:"g",user:"u2"}]);
  guard.stop();
});
