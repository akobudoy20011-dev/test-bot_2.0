"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createGroupTitleGuard}=require("../group-title-guard");

test("title guard restores a configured title when the current title differs",async()=>{
  const calls=[];
  const store={isInitialized:()=>true,async getGroup(){return {autolockEnabled:true,expectedTitle:"Protected name"};},async listProtectedGroups(){return [];}};
  const api={
    getThreadInfo(id,callback){callback(null,{threadName:"Changed name"});},
    setTitle(title,id,callback){calls.push({title,id});callback(null,true);}
  };
  const guard=createGroupTitleGuard({store,getApi:()=>api,cooldownMs:30000});
  const result=await guard.repair("group-1","test");
  assert.equal(result.restored,true);
  assert.deepEqual(calls,[{title:"Protected name",id:"group-1"}]);
  guard.stop();
});

test("title guard does not mutate a group without an enabled lock",async()=>{
  let mutations=0;
  const store={async getGroup(){return {autolockEnabled:false,expectedTitle:""};}};
  const guard=createGroupTitleGuard({store,getApi:()=>({setTitle(){mutations++;}})});
  const result=await guard.repair("group-1");
  assert.equal(result.skipped,true);
  assert.equal(mutations,0);
  guard.stop();
});
