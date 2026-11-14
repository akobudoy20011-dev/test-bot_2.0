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


test("countdown completes all 100 numbers and records a WIN",async()=>{
  const messages=[],results=[];
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"target",countdownTargetName:"Target",inactivityMs:5,countDelayMs:1};},
    async saveCountdownState(){},async deleteCountdownState(){},
    async loadCountdownStates(){return [];},
    async recordCountdownResult(item){results.push(item);}
  };
  const api={sendMessage(message,_thread,callback){messages.push(String(message));callback(null,{messageID:String(messages.length)});}};
  const engine=createCountdownEngine({store,getApi:()=>api});
  await engine.onMessage(api,{type:"message",threadID:"g-win",senderID:"target"});
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.deepEqual(messages.slice(0,100),Array.from({length:100},(_,i)=>String(i+1)));
  assert.match(messages[100],/WIN: TEST BOT/);
  assert.equal(results.length,1);
  assert.equal(results[0].result,"WIN");
  assert.equal(engine.getActive().length,0);
  engine.stop();
});

test("countdown completion uses the separately configured Test Bot receipt identity and reason",async()=>{
  const messages=[];
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"target",countdownTargetName:"Target",inactivityMs:1,countDelayMs:1};},
    async getCountdownReceiptSettings(){return {winnerName:"MY TEST ACCOUNT",reason:"CUSTOM TEST RECEIPT"};},
    async saveCountdownState(){},async deleteCountdownState(){},async loadCountdownStates(){return [];},async recordCountdownResult(){}
  };
  const api={sendMessage(message,_thread,callback){messages.push(String(message));callback(null,true);}};
  const engine=createCountdownEngine({store,getApi:()=>api});
  await engine.onMessage(api,{type:"message",threadID:"g-custom-receipt",senderID:"target"});
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.match(messages[100],/WIN: MY TEST ACCOUNT/);
  assert.match(messages[100],/REASON: CUSTOM TEST RECEIPT/);
  engine.stop();
});

test("target returning during the countdown cancels remaining numbers and records a LOSE",async()=>{
  const messages=[],results=[];
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"target",countdownTargetName:"Target",inactivityMs:1,countDelayMs:40};},
    async saveCountdownState(){},async deleteCountdownState(){},
    async loadCountdownStates(){return [];},
    async recordCountdownResult(item){results.push(item);}
  };
  const api={sendMessage(message,_thread,callback){messages.push(String(message));callback(null,true);}};
  const engine=createCountdownEngine({store,getApi:()=>api});
  await engine.onMessage(api,{type:"message",threadID:"g-return",senderID:"target"});
  for(let i=0;i<50&&!messages.includes("1");i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(messages.includes("1"));
  await engine.onMessage(api,{type:"message",threadID:"g-return",senderID:"target"});
  await engine.cancel("g-return");
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(messages.includes("2"),false);
  assert.equal(results.some(item=>item.result==="LOSE"&&item.reason==="TARGET_RETURNED"),true);
  engine.stop();
});

test("restores an interrupted countdown from its next unsent number",async()=>{
  const messages=[],results=[];
  const started=Date.now()-1000;
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"target",countdownTargetName:"Target",inactivityMs:300000,countDelayMs:1};},
    async saveCountdownState(){},async deleteCountdownState(){},
    async loadCountdownStates(){return [{threadID:"g-restore",targetId:"target",targetName:"Target",lockedAt:started,lastActivityAt:started,countdownStartedAt:started,nextNumber:4,status:"counting"}];},
    async recordCountdownResult(item){results.push(item);}
  };
  const api={sendMessage(message,_thread,callback){messages.push(String(message));callback(null,true);}};
  const engine=createCountdownEngine({store,getApi:()=>api});
  await engine.restore(api);
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.deepEqual(messages.slice(0,97),Array.from({length:97},(_,i)=>String(i+4)));
  assert.match(messages[97],/WIN: TEST BOT/);
  assert.equal(results[0].result,"WIN");
  engine.stop();
});

test("Messenger send failure leaves the failed number pending for retry",async()=>{
  const saved=[];
  const store={
    isInitialized:()=>true,
    async getGroup(){return {countdownEnabled:true,countdownTargetId:"target",countdownTargetName:"Target",inactivityMs:1,countDelayMs:1};},
    async saveCountdownState(item){saved.push(item);},async deleteCountdownState(){},
    async loadCountdownStates(){return [];},async recordCountdownResult(){}
  };
  const api={sendMessage(_message,_thread,callback){callback(new Error("Messenger unavailable"));}};
  const engine=createCountdownEngine({store,getApi:()=>api});
  await engine.onMessage(api,{type:"message",threadID:"g-fail",senderID:"target"});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(engine.getActive()[0].nextNumber,1);
  assert.equal(saved.some(item=>item.status==="send_failed"&&item.nextNumber===1),true);
  await engine.cancel("g-fail");
  engine.stop();
});
