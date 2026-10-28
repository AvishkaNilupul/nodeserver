const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup({ownedAfter=false,alreadyOwned=false,worker='submitted',enabled=true,sold=false,revokedAfter=false}={}) {
 let reads=0,purchases=0;const module={exports:{}};
 const epic={getLibraryRecords:async()=>++reads===1?(alreadyOwned?[{namespace:'game'}]:[]):(ownedAfter?[{namespace:'game'}]:[]),autoClaimFreebie:async()=>{purchases++;return {status:worker};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicAutoClaim'),'utf8'),{module,exports:module.exports,process:{env:{}},Buffer,Date,Map,Set,console,require:name=>{
 if(name==='axios')return {};
 if(name==='./epicClient')return epic;
 if(name==='./epicAccountToken')return {accountAccessToken:async()=>{if(revokedAfter){const e=Error('Login revoked');e.epicCode='invalid_grant';throw e;}return 'fresh';}};
 if(name==='./epicClaimResult')return {verifyClaimResult:(r,n,read)=>require('../utils/epicClaimResult').verifyClaimResult(r,n,read,{sleep:async()=>{}})};
 if(name==='./settings')return {getEpicAutoClaim:()=>({enabled,dailyCap:20,perAccountCooldownH:0})};
 if(name==='./captchaSolver')return {detectProvider:()=>''};
 if(name==='./secretBox')return {decrypt:v=>v};throw Error(name);
 }});
 const a={accountId:'a'.repeat(32),sold,autoClaimLog:[],save:async()=>{}};
 return {run:opts=>module.exports.attemptAutoClaim(a,{namespace:'game',offerId:'offer'},'access',opts),a,purchases:()=>purchases};
}
test('a submitted checkout is only logged claimed after library verification',async()=>{
 const s=setup({ownedAfter:true});const result=await s.run();assert.equal(result.status,'claimed');assert.equal(s.a.autoClaimCount,1);assert.equal(s.a.autoClaimLog[0].status,'claimed');
});
test('a timeout after entitlement grant becomes a verified success',async()=>assert.equal((await setup({ownedAfter:true,worker:'error'}).run()).status,'claimed'));
test('already owned preflight skips checkout',async()=>{const s=setup({alreadyOwned:true});assert.equal((await s.run()).status,'already_owned');assert.equal(s.purchases(),0);});
test('unverified worker success never increments successful claims',async()=>{const s=setup({worker:'claimed'});assert.equal((await s.run()).status,'error');assert.equal(s.a.autoClaimCount,undefined);});
test('manual control respects sold accounts and can bypass disabled scheduler',async()=>{
 const sold=setup({sold:true});assert.equal((await sold.run({manual:true})).status,'sold');assert.equal(sold.purchases(),0);
 const manual=setup({enabled:false,ownedAfter:true});assert.equal((await manual.run({manual:true})).status,'claimed');
});

test('a working library access token cannot hide a revoked refresh token',async()=>{
 const s=setup({ownedAfter:true,revokedAfter:true});const result=await s.run();assert.equal(result.status,'claimed');assert.equal(result.tokenNeedsLogin,true);assert.equal(s.a.status,'needs_login');
});
