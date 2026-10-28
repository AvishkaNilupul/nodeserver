const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync(require.resolve('../public/epic-accounts.html'),'utf8');
const source=html.slice(html.indexOf('      var pendingClaimLinks'),html.indexOf('      window.toggleSold'));
function setup(api) {
 const messages=[];let loads=0;
 const context={Set,Error,window:{open(){throw Error('Phone browser login must not open');}},api,toast:(text,error)=>messages.push({text,error}),load:async()=>loads++};
 vm.runInNewContext(source,context);return {claim:context.window.claimNow,messages,loads:()=>loads};
}
test('phone claim uses the verified worker without opening an Epic browser session',async()=>{
 let url;const s=setup(async u=>{url=u;return {result:{status:'claimed',verified:true}};});await s.claim('account','offer');assert.equal(url,'/api/epic/accounts/account/auto-claim');assert.equal(s.loads(),1);
});
test('repeated phone taps share one pending claim',async()=>{
 let release,calls=0;const s=setup(()=>{calls++;return new Promise(r=>release=r);});const first=s.claim('account','offer');await s.claim('account','offer');assert.equal(calls,1);release({result:{status:'already_owned'}});await first;
});
test('a visible challenge stays surfaced as an incomplete claim',async()=>{
 const s=setup(async()=>({result:{status:'needs_captcha',error:'Security check required'}}));await s.claim('account','offer');assert.equal(s.loads(),0);assert.equal(s.messages.at(-1).error,true);
});
