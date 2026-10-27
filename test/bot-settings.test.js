"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const settingsFile=path.join(os.tmpdir(),"test-bot-settings-"+process.pid+".json");
process.env.BOT_SETTINGS_PATH=settingsFile;
const settings=require("../bot-settings");
test("reaction and group settings validate and persist",t=>{
 t.after(()=>{try{fs.unlinkSync(settingsFile)}catch(_){}delete process.env.BOT_SETTINGS_PATH;});
 assert.equal(settings.getReactionSettings().emoji,"😆");
 assert.deepEqual(settings.updateReaction({enabled:true,emoji:"🔥",target:"both",probability:100,cooldownSeconds:60}),{enabled:true,emoji:"🔥",target:"both",probability:100,cooldownSeconds:60});
 const g=settings.updateGroup("123456",{banatMode:"off",typingEnabled:false,replyDelayMs:1250,cooldownMs:0,quietStart:"22:00",quietEnd:"06:00"});
 assert.equal(g.banatMode,"off");assert.equal(g.typingEnabled,false);assert.equal(g.replyDelayMs,1250);
 assert.equal(settings.getGroupSettings("123456").quietStart,"22:00");
 assert.equal(settings.isQuietNow(g,new Date("2026-01-01T17:30:00.000Z")),true);
 assert.equal(settings.isQuietNow(g,new Date("2026-01-01T08:00:00.000Z")),false);
 assert.equal(settings.shouldReact("123456","bot_replies"),true);
 assert.equal(settings.shouldReact("123456","incoming_messages"),false);
 assert.equal(JSON.parse(fs.readFileSync(settingsFile,"utf8")).groups["123456"].banatMode,"off");
});
