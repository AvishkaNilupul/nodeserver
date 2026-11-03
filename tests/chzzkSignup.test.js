const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {LocalVault}=require('../tools/chzzk-signup/vault.cjs'),{Engine}=require('../tools/chzzk-signup/engine.cjs'),{FiveSim,ProviderError,candidates}=require('../tools/chzzk-signup/five-sim.cjs');
const {importAccount,validate}=require('../tools/chzzk-signup/cloud-import.cjs');
const countries={canada:{prefix:{'+1':1},text_en:'Canada'},portugal:{prefix:{'+351':1},text_en:'Portugal'},netherlands:{prefix:{'+31':1},text_en:'Netherlands'}};
const prices={naver:{canada:{virtual8:{cost:.03,count:5}},portugal:{virtual51:{cost:.04,count:5}},netherlands:{virtual53:{cost:.0449,count:5}}}};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chzzk-signup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const vault=new LocalVault(dir),orders=new Map();let sequence=0,bought=0;
  const provider={prices:async()=>prices,countries:async()=>countries,
    buy:async(country,cap)=>{bought++;const o={id:++sequence,country,phone:(Object.keys(countries[country].prefix)[0])+'5551234567',price:cap,product:'naver',status:'PENDING',sms:[],expires:new Date(Date.now()+300000).toISOString(),created_at:new Date().toISOString()};orders.set(o.id,o);return structuredClone(o);},
    order:async(id,action)=>{const o=orders.get(id);if(action==='cancel')o.status='CANCELED';if(action==='finish')o.status='FINISHED';return structuredClone(o);},
    history:async()=>[...orders.values()]};
  const engine=new Engine({vault,provider}),s=engine.start({name:'Test Owner',birthday:'19950102'});
  return{engine,vault,provider,s,orders,dir,bought:()=>bought};
}
test('price order uses live stock, not historical success or operator rate',()=>{
  assert.deepEqual(candidates(prices,countries).map(x=>x.country),['canada','portugal','netherlands']);
  assert.equal(candidates(prices,countries,[],.02).length,0);
  assert.equal(candidates(prices,countries,[{country:'canada'}])[0].country,'portugal');
});
test('failed SMS changes number and then country without replacing the identity',async t=>{
  const {engine,s,orders}=fixture(t),password=s.password,id=s.id;
  await engine.number(id);assert.equal(s.order.country,'canada');
  await engine.replace(id);assert.equal(orders.get(1).status,'CANCELED');
  await engine.number(id);assert.equal(s.order.country,'portugal');
  await engine.replace(id);await engine.number(id);
  assert.equal(s.order.country,'netherlands');assert.equal(s.id,id);assert.equal(s.password,password);assert.equal(s.attempts.length,3);
});
test('no duplicate purchase when a number is already assigned',async t=>{
  const f=fixture(t);await f.engine.number(f.s.id);await f.engine.number(f.s.id);assert.equal(f.bought(),1);
});
test('a sold-out quote advances to the next cheapest country without counting a purchase',async t=>{
  const f=fixture(t),buy=f.provider.buy;
  f.provider.buy=async(country,cap)=>{if(country==='canada')throw new ProviderError('No stock',{code:'NO_STOCK'});return buy(country,cap);};
  await f.engine.number(f.s.id);assert.equal(f.s.order.country,'portugal');assert.equal(f.s.attempts.length,1);assert.equal(f.s.spent,.04);
});
test('SMS arrival prevents cancellation and replacement',async t=>{
  const f=fixture(t);await f.engine.number(f.s.id);f.orders.get(1).sms=[{code:'123456'}];
  await assert.rejects(f.engine.replace(f.s.id),/SMS already arrived/);assert.equal(f.s.order.id,1);assert.equal(f.bought(),1);
});
test('ambiguous purchase persists across restart and reconciles without rebuying',async t=>{
  const f=fixture(t),buy=f.provider.buy;
  f.provider.buy=async(...a)=>{await buy(...a);throw new ProviderError('lost response',{ambiguous:true});};
  await assert.rejects(f.engine.number(f.s.id));assert.ok(f.s.purchaseIntent);
  const restarted=new Engine({vault:new LocalVault(f.dir),provider:f.provider});
  await assert.rejects(restarted.number(f.s.id),/Reconcile/);
  await restarted.reconcile(f.s.id);assert.equal(restarted.active().order.id,1);assert.equal(f.bought(),1);
});
test('unresolved purchase never clears its intent or spends again',async t=>{
  const f=fixture(t);f.provider.buy=async()=>{throw new ProviderError('timeout',{ambiguous:true});};
  await assert.rejects(f.engine.number(f.s.id));await assert.rejects(f.engine.reconcile(f.s.id),/unresolved/);assert.ok(f.s.purchaseIntent);
});
test('reconciliation accepts the real 5sim Data history envelope',async t=>{
  const f=fixture(t),buy=f.provider.buy;f.provider.buy=async(...a)=>{await buy(...a);throw new ProviderError('timeout',{ambiguous:true});};
  await assert.rejects(f.engine.number(f.s.id));f.provider.history=async()=>({Data:[...f.orders.values()],Total:1});await f.engine.reconcile(f.s.id);assert.equal(f.s.order.id,1);
});
test('a manually completed SMS can be adopted without buying or resetting the signup',async t=>{
  const f=fixture(t),o=await f.provider.buy('canada',.04);o.created_at=new Date(Date.now()+1000).toISOString();o.sms=[{code:'1234'}];f.orders.set(o.id,o);
  await f.engine.adoptExistingOrder(f.s.id,o.id);assert.equal(f.bought(),1);assert.equal(f.s.attempts[0].manual,true);
  await f.engine.accountName(f.s.id,'alex_morgan_248');assert.equal(f.s.username,'alex_morgan_248');
  await assert.rejects(f.engine.accountName(f.s.id,'another_account'),/cannot change/);
});
test('failed cancellation holds the old order',async t=>{
  const f=fixture(t);await f.engine.number(f.s.id);f.provider.order=async()=>structuredClone(f.orders.get(1));
  await assert.rejects(f.engine.replace(f.s.id),/Wait for cancellation/);assert.equal(f.s.order.id,1);await f.engine.number(f.s.id);assert.equal(f.bought(),1);
});
test('gross spend budget stops further purchases even after refunds',async t=>{
  const f=fixture(t);f.s.budget=.05;await f.engine.number(f.s.id);await f.engine.replace(f.s.id);
  await assert.rejects(f.engine.number(f.s.id),/remaining budget/);assert.equal(f.bought(),1);
});
test('attempt limit and serialization prevent runaway purchases',async t=>{
  const f=fixture(t);f.s.maxAttempts=1;await f.engine.number(f.s.id);await f.engine.replace(f.s.id);
  await assert.rejects(f.engine.number(f.s.id),/attempt limit/);
  f.engine.busy=true;await assert.rejects(f.engine.number(f.s.id),/operation is running/);
});
test('explicit limit changes preserve identity and cannot erase gross spend',async t=>{
  const f=fixture(t);await f.engine.number(f.s.id);const password=f.s.password;
  await f.engine.limits(f.s.id,{maxPrice:.05,budget:1,maxAttempts:50});assert.equal(f.s.budget,1);assert.equal(f.s.password,password);assert.equal(f.s.attempts.length,1);
  await assert.rejects(f.engine.limits(f.s.id,{maxPrice:.05,budget:.01,maxAttempts:50}),/purchases already made/);assert.equal(f.s.budget,1);
});
test('purchase endpoint uses any operator and provider-enforced maxPrice',async()=>{
  let called;const p=new FiveSim({token:'test-key',fetchImpl:async(url,opts)=>{called={url,opts};return{ok:true,text:async()=>JSON.stringify({id:12,phone:'+15551234567',product:'naver',country:'canada',price:.03,expires:new Date().toISOString()})};}});
  await p.buy('canada',.03);assert.match(called.url,/canada\/any\/naver\?maxPrice=0.03$/);assert.equal(called.opts.redirect,'error');
});
test('malformed purchase is ambiguous and never retried',async()=>{
  let count=0;const p=new FiveSim({token:'test',fetchImpl:async()=>{count++;return{ok:true,text:async()=>'bad response with private data'};}});
  await assert.rejects(p.buy('canada',.03),e=>e.ambiguous&&!e.message.includes('private data'));assert.equal(count,1);
});
test('verified account is durable before finishing provider order',async t=>{
  const f=fixture(t);await f.engine.number(f.s.id);f.orders.get(1).sms=[{code:'1234'}];await f.engine.sms(f.s.id);
  const cookies=['NID_AUT','NID_SES'].map(name=>({name,value:'secret-'+name,domain:'.naver.com'}));
  const finish=f.provider.order;f.provider.order=async(id,action)=>{if(action==='finish'){assert.equal(new LocalVault(f.dir).data.accounts.length,1);throw Error('offline');}return finish(id,action);};
  await f.engine.complete(f.s.id,{cookies,userIdHash:'user-hash',naverId:f.s.username});
  assert.equal(f.vault.data.accounts[0].finishPending,true);assert.equal(f.engine.active(),undefined);
  assert.ok(!fs.readFileSync(f.vault.filename,'utf8').includes('secret-NID_AUT'));
});
test('wrong browser identity and missing SMS cannot create local stock',async t=>{
  const f=fixture(t);await f.engine.number(f.s.id);
  await assert.rejects(f.engine.complete(f.s.id,{cookies:[],userIdHash:'other',naverId:'other'}),/assigned account/);assert.equal(f.vault.data.accounts.length,0);
});
test('cloud import never updates existing account state or credentials',async()=>{
  const cookies=['NID_AUT','NID_SES'].map(name=>({name,value:'secret',domain:'.naver.com'}));let write;
  const payload={version:1,localId:'local-id',userIdHash:'hash',cookies};
  const Account={updateOne:async(filter,update,opts)=>{write={filter,update,opts};return{upsertedCount:0};},findOne:()=>({select:()=>({lean:async()=>({_id:'cloud-id'})})})};
  const r=await importAccount({payload,Account,client:{userStatus:async()=>({loggedIn:true,userIdHash:'hash',nickname:'Owner'})},jar:{cookies:()=>cookies},encrypt:s=>'encrypted:'+s});
  assert.equal(r.alreadyPresent,true);assert.deepEqual(Object.keys(write.update),['$setOnInsert']);assert.equal(write.opts.timestamps,false);
  await assert.rejects(importAccount({payload,Account,client:{userStatus:async()=>({loggedIn:true,userIdHash:'wrong'})},jar:{cookies:()=>cookies},encrypt:s=>s}),/Wrong login/);
  assert.throws(()=>validate({...payload,cookies:[{name:'NID_AUT',value:'stolen',domain:'.example.com'}]}));
});
test('loopback API rejects foreign hosts/origins and keeps credentials out of normal state',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chzzk-app-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {app,token}=require('../tools/chzzk-signup/local-app.cjs').createApp({dataDir:dir,port:0,provider:{},upload:null});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(pathname,{auth=true,host='127.0.0.1:0',origin,body}={})=>new Promise((resolve,reject)=>{
    const r=require('http').request({hostname:'127.0.0.1',port:server.address().port,path:pathname,method:body?'POST':'GET',headers:{Host:host,...(auth?{'X-Local-Token':token}:{}),...(origin?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}));});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await request('/api/state',{auth:false})).status,403);
  assert.equal((await request('/api/state',{host:'evil.example'})).status,403);
  assert.equal((await request('/api/state',{origin:'https://evil.example'})).status,403);
  const started=await request('/api/start',{body:{name:'Test Profile',birthday:'19950102'}});assert.equal(started.status,200);
  const id=JSON.parse(started.text).session.id,identity=await request('/api/session/'+id+'/identity',{body:{}}),password=JSON.parse(identity.text).identity.password;
  assert.equal(password.length,16);
  const state=await request('/api/state');assert.equal(state.status,200);assert.ok(!state.text.includes(password));assert.ok(!state.text.includes('password'));assert.ok(!state.text.includes('cookies'));
});
