"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createCountdownEngine}=require("../countdown-engine");

test("countdown starts only after a configured target speaks and persists the waiting state",async()=>{
  const saved=[];
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"member-1",countdownTargetName:"Target",inactivityMs:300000,countDelayMs:2000};},
    async saveCountdownState(value){saved.push(value);},
    async deleteCountdownState(){},
    async loadCountdownStates(){return [];},
    async recordCountdownResult(){}
  };
  const engine=createCountdownEngine({store,getApi:()=>({})});
  await engine.onMessage({}, {type:"message",threadID:"group-1",senderID:"other"});
  assert.equal(engine.getActive().length,0);
  await engine.onMessage({}, {type:"message",threadID:"group-1",senderID:"member-1"});
  assert.equal(engine.getActive().length,1);
  assert.equal(engine.getActive()[0].targetId,"member-1");
  assert.equal(saved.at(-1).status,"waiting");
  engine.pause();
  assert.equal(engine.getActive().length,0);
});

test("countdown ignores unconfigured and non-message events",async()=>{
  let lookups=0;
  const store={isInitialized:()=>true,async getGroup(){lookups++;return {countdownEnabled:false};}};
  const engine=createCountdownEngine({store});
  await engine.onMessage({}, {type:"event",threadID:"g",senderID:"u"});
  assert.equal(lookups,0);
});

test("dashboard cancellation clears the active countdown without recording a result",async()=>{
  let deleted=0,recorded=0;
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"member-1",countdownTargetName:"Target",inactivityMs:300000,countDelayMs:2000};},
    async saveCountdownState(){},
    async deleteCountdownState(){deleted++;},
    async loadCountdownStates(){return [];},
    async recordCountdownResult(){recorded++;}
  };
  const engine=createCountdownEngine({store});
  await engine.onMessage({}, {type:"message",threadID:"group-2",senderID:"member-1"});
  assert.equal(engine.getActive().length,1);
  assert.equal(await engine.cancel("group-2"),true);
  assert.equal(engine.getActive().length,0);
  assert.equal(deleted,1);
  assert.equal(recorded,0);
});
