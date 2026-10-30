const fs=require('fs'),path=require('path'),crypto=require('crypto');
const DEFAULT_SECONDS=6*60*60,MAX_SECONDS=24*60*60;
// A 429 this soon after the last pause ended means Epic's limit outlasted that
// pause, so the next one doubles (6 h, 12 h, 24 h) instead of probing every 6 h.
const REPEAT_WINDOW_MS=12*60*60*1000;
function createBackoff({file,now=Date.now}) {
 let memoryUntil=0;
 function read() {
  try { return JSON.parse(fs.readFileSync(file,'utf8'))||{}; } catch { return {}; }
 }
 function write(data) {
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(data)+'\n',{mode:0o600});
  fs.renameSync(temporary,file);
 }
 function until() {
  try { const t=Number(JSON.parse(fs.readFileSync(file,'utf8')).until);if(Number.isFinite(t))memoryUntil=Math.max(memoryUntil,t); }
  catch(e){if(e.code!=='ENOENT'&&!memoryUntil)memoryUntil=now()+DEFAULT_SECONDS*1000;}
  return memoryUntil>now()?memoryUntil:0;
 }
 function block(seconds) {
  const n=Number(seconds),prev=read(),prevUntil=Number(prev.until)||0;
  // Files written before `seconds` was stored always held the 6-hour default.
  const prevSeconds=prev.seconds==null?(prevUntil?DEFAULT_SECONDS:0):Number(prev.seconds)||0;
  let duration;
  if(Number.isFinite(n)&&n>0)duration=Math.max(60,Math.min(MAX_SECONDS,n));
  else if(prevSeconds>0&&prevUntil&&now()-prevUntil<REPEAT_WINDOW_MS)duration=Math.min(MAX_SECONDS,prevSeconds*2);
  else duration=DEFAULT_SECONDS;
  memoryUntil=Math.max(until(),now()+duration*1000);
  write({until:memoryUntil,seconds:duration,reason:'Epic checkout HTTP 429'});
  return memoryUntil;
 }
 // Epic answered a checkout normally: its limit has cleared, so the next 429
 // starts again from the 6-hour pause.
 function settle() {
  const prev=read();
  if(!prev.until||prev.seconds===0||Number(prev.until)>now())return;
  try { write({...prev,seconds:0}); } catch {}
 }
 return {until,block,settle};
}
module.exports={createBackoff,...createBackoff({file:path.join(__dirname,'../_epic_claim_backoff.json')})};
