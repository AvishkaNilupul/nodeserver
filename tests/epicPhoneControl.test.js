const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {createPhoneControl, controlToken} = require('../utils/epicPhoneControl');
const {mountPhonePanel} = require('../extension/epic-claim-helper-android/phone/phone-panel.cjs');
const secret = 'test-worker-secret';
const authorization = 'Bearer ' + controlToken(secret);
async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return 'http://127.0.0.1:' + server.address().port;
}
function fixture(overrides = {}) {
  let active = false, starts = 0, stops = 0;
  const batch = {status: () => ({state: active ? 'running' : 'idle', total: active ? 2 : 0, completed: 0, jobs: []}),
    isActive: () => active, start: async () => { if (!active) starts++; active = true; }, stop: () => { stops++; active = false; return batch.status(); }};
  const app = express();
  app.use(createPhoneControl({secret, plan: async () => [
    {accountId:'a',game:'Game A',private:'never publish'}, {accountId:'a',game:'Game B'}, {accountId:'b',game:'Game A'},
  ], batch, claimerStatus: () => ({}), workerReady: async () => ({ready:true}), singleRunning: () => false, ...overrides}));
  return {app, counts: () => ({starts, stops})};
}
test('phone API rejects missing/wrong credentials; preview counts without starting claims or returning account identities', async t => {
  const f = fixture(), base = await serve(t, f.app);
  assert.equal((await fetch(base+'/api/epic/phone/claims')).status,401);
  assert.equal((await fetch(base+'/api/epic/phone/claims',{headers:{Authorization:'Bearer wrong'}})).status,401);
  const r=await fetch(base+'/api/epic/phone/claims',{headers:{Authorization:authorization}}),d=await r.json();
  assert.equal(d.pending,3);assert.equal(d.accounts,2);assert.deepEqual(d.games,[{title:'Game A',count:2},{title:'Game B',count:1}]);
  assert.equal(JSON.stringify(d).includes('private'),false);assert.equal(f.counts().starts,0);
  assert.equal(r.headers.get('cache-control'),'no-store');
});
test('repeat start joins singleton queue; stop uses that same queue', async t => {
  const f=fixture(),base=await serve(t,f.app),opts={method:'POST',headers:{Authorization:authorization}};
  const replies=await Promise.all([fetch(base+'/api/epic/phone/claims/start',opts),fetch(base+'/api/epic/phone/claims/start',opts)]);
  assert.deepEqual(replies.map(r=>r.status),[202,202]);assert.equal(f.counts().starts,1);
  assert.equal((await fetch(base+'/api/epic/phone/claims/stop',opts)).status,200);assert.equal(f.counts().stops,1);
});
test('cooldown and unavailable worker refuse a new batch',async t=>{
  for(const [overrides,status] of [[{claimerStatus:()=>({rateLimitedUntil:'2099-01-01'})},409],[{workerReady:async()=>({ready:false,reason:'Open Firefox'})},503]]){
    const f=fixture(overrides),base=await serve(t,f.app);assert.equal((await fetch(base+'/api/epic/phone/claims/start',{method:'POST',headers:{Authorization:authorization}})).status,status);assert.equal(f.counts().starts,0);
  }
});
test('phone-local dashboard authenticates controls, does not expose the worker secret, and forwards only fixed HTTPS routes',async t=>{
  const app=express();let beats=0,forwarded=[];
  mountPhonePanel(app,{token:secret,serverUrl:'https://example.invalid',visible:()=>beats++,request:async(url,opts)=>{forwarded.push({url:String(url),...opts});return {status:200,json:async()=>({success:true,pending:2})}}});
  const base=await serve(t,app);const html=await (await fetch(base+'/phone')).text();assert.equal(html.includes(secret),false);assert.equal(html.includes(controlToken(secret)),true);
  assert.equal(await new Promise((resolve,reject)=>{const u=new URL(base);require('node:http').get({hostname:u.hostname,port:u.port,path:'/phone',headers:{Host:'evil.invalid'}},r=>{r.resume();resolve(r.statusCode)}).on('error',reject)}),403);
  assert.equal((await fetch(base+'/phone',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await fetch(base+'/phone/control/start',{method:'POST'})).status,401);
  await fetch(base+'/phone/control/visible',{method:'POST',headers:{Authorization:authorization}});assert.equal(beats,1);
  await fetch(base+'/phone/control/start',{method:'POST',headers:{Authorization:authorization}});assert.equal(forwarded[0].url,'https://example.invalid/api/epic/phone/claims/start');assert.equal(forwarded[0].headers.Authorization,authorization);assert.equal(forwarded[0].redirect,'error');
});
test('home shortcut shows count before automatic start; checkout return never starts another batch',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const html=fs.readFileSync(require('node:path').join(__dirname,'../extension/epic-claim-helper-android/phone/phone-panel.html'),'utf8');
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  async function boot(pathname,initialState="idle"){
    const elements=new Map(),calls=[],intervals=[];
    const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',style:{},replaceChildren(){},append(){}});return elements.get(id)};
    let started=false;
    const context={URLSearchParams,AbortSignal,location:{pathname,search:''},history:{replaceState(){}},Date,
      document:{visibilityState:'visible',getElementById:element,createElement:()=>({append(){}}),addEventListener(){}},
      setInterval(fn,ms){intervals.push({fn,ms});return intervals.length},clearInterval(){},
      fetch:async(url)=>{calls.push(url);if(url.endsWith('/start'))started=true;return {ok:true,json:async()=>url.endsWith('/visible')?{success:true}:{success:true,pending:9,accounts:9,games:[{title:'Free game',count:9}],worker:{ready:true},batch:{state:started?'running':initialState,total:started?9:0,completed:0}}}}};
    vm.runInNewContext(script,context);await new Promise(setImmediate);return {elements,calls,intervals};
  }
  const launch=await boot('/phone');assert.equal(launch.elements.get('count').textContent,9);assert.equal(launch.calls.some(x=>x.endsWith('/start')),false);
  const countdown=launch.intervals.filter(x=>x.ms===1000).at(-1);assert.ok(countdown);for(let n=0;n<4;n++)countdown.fn();await new Promise(setImmediate);assert.equal(launch.calls.filter(x=>x.endsWith('/start')).length,1);
  assert.equal(launch.elements.get('start').textContent,'Queue is running');
  const paused=await boot('/phone','paused');assert.equal(paused.intervals.filter(x=>x.ms===1000).length,1);assert.equal(paused.elements.get('start').textContent,'Continue claims');
  const returned=await boot('/connect');assert.equal(returned.intervals.filter(x=>x.ms===1000).length,1);assert.equal(returned.calls.some(x=>x.endsWith('/start')),false);
});
test('phone relay preserves server rate-limit retry time', async t => {
  const app=express();
  mountPhonePanel(app,{token:secret,serverUrl:'https://example.invalid',visible(){},
    request:async()=>({status:429,headers:{get:()=> '123'},json:async()=>({success:false,message:'Slow down'})})});
  const base=await serve(t,app),r=await fetch(base+'/phone/control/status',{headers:{Authorization:authorization}});
  assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'123');assert.equal((await r.json()).retryAfterSeconds,123);
});
test('dashboard waits out a status rate limit while local visibility beats continue', async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const html=fs.readFileSync(require.resolve('../extension/epic-claim-helper-android/phone/phone-panel.html'),'utf8');
  const elements=new Map(),intervals=[];let now=1000,statusCalls=0,beats=0;
  const el=id=>{if(!elements.has(id))elements.set(id,{style:{},replaceChildren(){}});return elements.get(id)};
  const context={URLSearchParams,AbortSignal,Date:class extends Date{static now(){return now}},
    location:{pathname:'/connect',search:''},history:{replaceState(){}},
    document:{visibilityState:'visible',getElementById:el,addEventListener(){}},clearInterval(){},
    setInterval(fn,ms){intervals.push({fn,ms})},fetch:async url=>{
      if(url.endsWith('/visible')){beats++;return {ok:true,json:async()=>({success:true})}}
      statusCalls++;return {ok:false,status:429,json:async()=>({success:false,message:'Slow down',retryAfterSeconds:120})};
    }};
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);await new Promise(setImmediate);
  assert.equal(statusCalls,1);assert.equal(el('connection').textContent,'Status delayed');
  const poll=intervals.find(x=>x.ms===30000).fn,beat=intervals.find(x=>x.ms===5000).fn;
  now+=30000;poll();await beat();assert.equal(statusCalls,1);assert.ok(beats>=2);
  now+=90001;poll();await new Promise(setImmediate);assert.equal(statusCalls,2);
});
