const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const real=require('../utils/epicClaimBatch');
function setup() {
  const source=fs.readFileSync(require.resolve('../routes/epicAccountRoutes'),'utf8');
  const code=source.slice(source.indexOf('// Both manual entry points'),source.indexOf('// Manual one-off:'));
  const a={_id:'a',status:'ok',displayName:'A',library:[],save:async()=>{}};
  const f={offerId:'offer',namespace:'game',active:true,upcoming:false};
  let current=a,run,claims=0,syncs=0,paused=null; const routes=[],auth=()=>{};
  const context={Date,Map,Promise,String,parseFloat,manualClaimRunning:false,requireSuperadmin:auth,
    router:{get:(...r)=>routes.push(r),post:(...r)=>routes.push(r)},
    EpicAccount:{find:()=>({sort:()=>({lean:async()=>[a]})}),findById:async()=>current},
    EpicFreebie:{find:()=>({lean:async()=>[f]}),findOne:()=>({lean:async()=>f})},
    accountAccessToken:async()=>{assert.equal(current.sold,undefined);return 'access';},
    epicAutoClaim:{attemptAutoClaim:async(a,f,t,o)=>{assert.equal(o.manual,true);claims++;return {status:'claimed'};},getStatus:()=>({rateLimitedUntil:paused})},
    epicClaimer:{syncLibrary:async()=>syncs++},
    epicRegion:{loadBlockedCountries:async()=>new Map()},
    require:name=>name.includes('epicWatcher')?{refreshIfStale:async()=>{}}:({...real,createClaimBatch:deps=>real.createClaimBatch({...deps,schedule:f=>run=f})})};
  vm.runInNewContext(code+'globalThis.batch=claimBatch;',context);
  return {routes,auth,batch:context.batch,run:()=>run(),sold:()=>current={...a,sold:true},expire:()=>f.endDate=new Date(1),claims:()=>claims,syncs:()=>syncs,pause:at=>paused=at};
}
test('batch endpoints require the existing superadmin session',()=>{
  const s=setup();assert.equal(s.routes.length,3);for(const route of s.routes)assert.equal(route[1],s.auth);
});
test('an account sold or an offer expired after queue planning cannot reach checkout',async()=>{
  for(const change of ['sold','expire']){const s=setup();await s.batch.start();s[change]();await s.run();
    assert.equal(s.claims(),0);assert.equal(s.batch.status().jobs[0].state,'skipped');}
});
test('batch uses verified single-claim orchestration and refreshes the library',async()=>{
  const s=setup();await s.batch.start();await s.run();assert.equal(s.claims(),1);assert.equal(s.syncs(),1);
  assert.equal(s.batch.status().jobs[0].state,'claimed');
});
test('Claim all refuses to start while Epic has checkouts paused (HTTP 429)',async()=>{
  const s=setup();s.pause('2026-10-30T10:28:09.382Z');
  const post=s.routes.find(r=>r[0]==='/api/epic/claims/batch'&&r.length===3&&r[2].length===2&&String(r[2]).includes('claimBatch.start'));
  let code=0,body=null;const res={status(c){code=c;return this;},json(b){body=b;return this;}};
  await post[2]({},res);
  assert.equal(code,409);assert.equal(body.rateLimitedUntil,'2026-10-30T10:28:09.382Z');assert.match(body.message,/HTTP 429/);
  assert.equal(s.batch.status().state,'idle');
  s.pause(null);await post[2]({},res);assert.equal(code,202);
});
