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
