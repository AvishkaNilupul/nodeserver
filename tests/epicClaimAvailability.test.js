const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(post){let blocked=0;const module={exports:{}},account={accountId:'a'.repeat(32),autoClaimLog:[],save:async()=>{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicAutoClaim'),'utf8'),{module,exports:module.exports,Date,Buffer,Set,process:{env:{EPIC_CLAIM_WORKER_URL:'http://worker',EPIC_CLAIM_WORKER_TOKEN:'fixture'}},require:n=>{
 if(n==='./epicClaimBackoff')return {until:()=>blocked,block:()=>blocked=Date.now()+60000};
 if(n==='axios')return {post};
 if(n==='./epicOfferWindow')return require('../utils/epicOfferWindow');
 if(n==='./epicRegion')return require('../utils/epicRegion');
 if(n==='./epicClient')return {exchangeCode:async()=> 'code',getLibraryRecords:async()=>[]};
 if(n==='./epicClaimResult')return {verifyClaimResult:async r=>r};
 if(n==='./epicAccountToken')return {accountAccessToken:async()=> 'access'};
 if(n==='./settings')return {getEpicAutoClaim:()=>({enabled:true,dailyCap:20,perAccountCooldownH:0})};
 if(n==='./captchaSolver')return {detectProvider:()=>''};
 if(n==='./secretBox')return {decrypt:v=>v};throw Error(n);
 }});return {api:module.exports,account,run:()=>module.exports.attemptAutoClaim(account,{namespace:'ns',offerId:'offer'},'access',{manual:true})};}
test('worker connection failures consume neither retries nor daily slots',async()=>{
 for(const code of ['ECONNREFUSED','ECONNRESET','ECONNABORTED','ETIMEDOUT']){
  const s=setup(async()=>{throw Object.assign(Error('Worker offline'),{code});});
  assert.equal((await s.run()).status,'worker_unavailable');assert.equal(s.account.autoClaimLog.length,0);assert.equal(s.api.getStatus().todayCount,0);
 }
});
test('manual and scheduler calls cannot mint overlapping worker jobs',async()=>{
 let release,calls=0;const s=setup(()=>{calls++;return new Promise(r=>release=r);});const first=s.run();
 await new Promise(r=>setImmediate(r));assert.equal((await s.run()).status,'busy');assert.equal(calls,1);
 release({status:503,data:{status:'worker_unavailable'}});await first;assert.equal(s.api.getStatus().todayCount,0);
});

test('a rate-limited order pauses subsequent accounts without burning retries or cap',async()=>{
 let calls=0;const s=setup(async()=>{calls++;return {status:200,data:{status:'rate_limited',retryAfterSeconds:120}};});
 assert.equal((await s.run()).status,'rate_limited');assert.equal(s.account.autoClaimLog.length,0);assert.equal(s.api.getStatus().todayCount,0);
 assert.equal((await s.run()).status,'rate_limited');assert.equal(calls,1);assert.ok(s.api.getStatus().rateLimitedUntil);
});
