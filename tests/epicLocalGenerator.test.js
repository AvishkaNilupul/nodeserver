const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createLocalApp}=require('../tools/epic-signup/local-app.cjs');
const {LocalVault}=require('../tools/epic-signup/local-vault.cjs');
test('local signup persists encrypted accounts across restarts without any website/database dependency',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epic-local-test-'));let server,instance,base,wrong=true,exchanges=0;
 const dependencies={dataDir:dir,exchangeAuthCode:async()=>{exchanges++;return{account_id:'fixture-id',displayName:'Local Example',refresh_token:'private-oauth-token'};},getProfile:async()=>({email:wrong?'different@outlook.com':'fixture@outlook.com',country:'CO'})};
 async function boot(){instance=createLocalApp(dependencies);server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;}
 async function call(route,body,{ui=true,bearer,origin,host='127.0.0.1:4107'}={}){
  return new Promise((resolve,reject)=>{const data=body?JSON.stringify(body):null;const r=require('http').request(base+route,{method:body?'POST':'GET',headers:{Host:host,'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{}),...(ui?{'X-Local-Token':instance.uiToken}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...(origin?{Origin:origin}:{})}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,cache:res.headers['cache-control'],data});});});r.on('error',reject);if(data)r.write(data);r.end();});
 }

 try{
  await boot();assert.equal((await call('/api/local/accounts',null,{ui:false})).status,403);assert.equal((await call('/api/local/accounts',null,{origin:'https://attacker.invalid'})).status,403);assert.equal((await call('/api/local/accounts',null,{host:'attacker.invalid'})).status,403);
  const started=await call('/api/epic/signup/start',{mailbox:{address:'fixture@outlook.com',provider:'outlook-local',reservedAt:new Date().toISOString()}});assert.equal(started.status,200);const initial=started.data.session;
  await new Promise(r=>server.close(r));await boot();
  const resumed=await call('/api/epic/signup/'+initial.sessionId+'/resume',{});assert.equal(resumed.data.session.identity.password,initial.identity.password);const current=resumed.data.session;
  const finish={sessionId:initial.sessionId,authorizationCode:'a'.repeat(32)};
  assert.equal((await call('/api/epic/accounts/from-extension',finish,{ui:false,bearer:initial.bearer})).status,401);
  assert.equal((await call('/api/epic/accounts/from-extension',finish,{ui:false,bearer:current.bearer})).status,502);assert.equal(instance.vault.data.accounts.length,0);
  wrong=false;const saved=await call('/api/epic/accounts/from-extension',finish,{ui:false,bearer:current.bearer,origin:'chrome-extension://fixture'});assert.equal(saved.status,200);assert.equal(saved.data.account.profile.country,'CO');assert.equal(saved.data.account.password,undefined);
  const count=exchanges;await call('/api/epic/accounts/from-extension',finish,{ui:false,bearer:current.bearer});assert.equal(exchanges,count);
  const disk=fs.readFileSync(path.join(dir,'accounts.vault'),'utf8');assert.ok(!disk.includes(initial.identity.password));assert.ok(!disk.includes('fixture@outlook.com'));assert.ok(!disk.includes('private-oauth-token'));assert.equal(fs.statSync(path.join(dir,'vault.key')).mode&0o777,0o600);
  await new Promise(r=>server.close(r));await boot();const list=await call('/api/local/accounts');assert.equal(list.data.accounts.length,1);assert.equal(list.cache,'no-store');assert.equal(list.data.accounts[0].refreshToken,undefined);
  const reveal=await call('/api/local/accounts/'+list.data.accounts[0]._id+'/reveal',{});assert.equal(reveal.data.password,initial.identity.password);assert.equal(reveal.data.refreshToken,undefined);
 }finally{if(server?.listening)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('a damaged vault fails closed instead of replacing saved accounts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'epic-local-corrupt-'));try{const v=new LocalVault(dir);v.save();fs.writeFileSync(v.filename,'damaged');assert.throws(()=>new LocalVault(dir));assert.equal(fs.readFileSync(v.filename,'utf8'),'damaged');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
