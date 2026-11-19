"use strict";
function isTimeCheck(body){return /^time\s*check\s*[!?]*$/i.test(String(body||"").trim());}
function formatTimeCheck(now=new Date()){return "time check: "+new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Manila",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);}
module.exports={isTimeCheck,formatTimeCheck};
