const fs=require('fs'),path=require('path'),crypto=require('crypto');
const DEFAULT_SECONDS=6*60*60;
function createBackoff({file,now=Date.now}) {
 let memoryUntil=0;
 function until() {
  try { const t=Number(JSON.parse(fs.readFileSync(file,'utf8')).until);if(Number.isFinite(t))memoryUntil=Math.max(memoryUntil,t); }
  catch(e){if(e.code!=='ENOENT'&&!memoryUntil)memoryUntil=now()+DEFAULT_SECONDS*1000;}
  return memoryUntil>now()?memoryUntil:0;
 }
 function block(seconds) {
  const n=Number(seconds),duration=Number.isFinite(n)&&n>0?Math.max(60,Math.min(86400,n)):DEFAULT_SECONDS;
  memoryUntil=Math.max(until(),now()+duration*1000);
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({until:memoryUntil,reason:'Epic checkout HTTP 429'})+'\n',{mode:0o600});
  fs.renameSync(temporary,file);return memoryUntil;
 }
 return {until,block};
}
module.exports={createBackoff,...createBackoff({file:path.join(__dirname,'../_epic_claim_backoff.json')})};
