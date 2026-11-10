"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {executeMassSetNickname}=require("../mass-setnn");

test("Mass SetNN revalidates membership and applies changes sequentially",async()=>{
  const calls=[],waits=[],saved=[];
  const result=await executeMassSetNickname({
    api:{changeNickname(name,thread,user,cb){calls.push({name,thread,user});cb(null);}},
    threadID:"g",userIDs:["u1","u2","u1"],nickname:"hello",
    getMembers:async()=>[{userID:"u1"},{userID:"u2"}],
    saveNickname:async (thread,user,nick)=>saved.push({thread,user,nick}),
    sleep:async ms=>waits.push(ms),delayMs:1200
  });
  assert.equal(result.total,2);
  assert.equal(result.succeeded,2);
  assert.deepEqual(calls.map(x=>x.user),["u1","u2"]);
  assert.deepEqual(waits,[1200]);
  assert.equal(result.lockSaved,2);
  assert.deepEqual(saved,[{thread:"g",user:"u1",nick:"hello"},{thread:"g",user:"u2",nick:"hello"}]);
});

test("Mass SetNN rejects stale members before making any changes",async()=>{
  let changed=0;
  await assert.rejects(executeMassSetNickname({
    api:{changeNickname(){changed++;}},threadID:"g",userIDs:["u1","u2"],nickname:"x",
    getMembers:async()=>[{userID:"u1"}]
  }),/no longer members/);
  assert.equal(changed,0);
});

test("Mass SetNN enforces selection and nickname limits",async()=>{
  const base={api:{changeNickname(_n,_t,_u,cb){cb(null);}},threadID:"g",nickname:"x",getMembers:async()=>Array.from({length:51},(_,i)=>({userID:"u"+i}))};
  await assert.rejects(executeMassSetNickname({...base,userIDs:[]}),/between 1 and 50/);
  await assert.rejects(executeMassSetNickname({...base,userIDs:Array.from({length:51},(_,i)=>"u"+i)}),/between 1 and 50/);
  await assert.rejects(executeMassSetNickname({...base,userIDs:["u1"],nickname:"x".repeat(65)}),/64 characters/);
});

test("Mass SetNN reports partial failures and continues",async()=>{
  const result=await executeMassSetNickname({
    api:{changeNickname(_n,_t,user,cb){if(user==="bad")cb(new Error("denied"));else cb(null);}},
    threadID:"g",userIDs:["bad","good"],nickname:"x",
    getMembers:async()=>[{userID:"bad"},{userID:"good"}],sleep:async()=>{},delayMs:0
  });
  assert.equal(result.succeeded,1);
  assert.equal(result.failed,1);
  assert.equal(result.results[0].error,"denied");
});

test("Mass SetNN reports when a nickname changed but its Neon lock could not be saved",async()=>{
  const result=await executeMassSetNickname({
    api:{changeNickname(_name,_thread,_user,cb){cb(null);}},
    threadID:"g",userIDs:["u1"],nickname:"locked",
    getMembers:async()=>[{userID:"u1"}],
    saveNickname:async()=>{throw new Error("database unavailable");},
    delayMs:0
  });
  assert.equal(result.succeeded,1);
  assert.equal(result.lockSaved,0);
  assert.equal(result.lockSaveFailed,1);
  assert.equal(result.results[0].ok,true);
  assert.equal(result.results[0].lockSaved,false);
});
