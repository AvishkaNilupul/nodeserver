const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const express = require('express');
const {createRouter} = require('../routes/outlookDashboardRoutes');
const listen = app => new Promise(resolve => {const server=app.listen(0,'127.0.0.1',()=>resolve(server));});

test('cloud proxy keeps auth, request bodies, path and same-origin checks', async t => {
  const upstream=express(); upstream.use(express.json());
  upstream.all('/api/pool/pick',(req,res)=>res.json({path:req.path,body:req.body}));
  const target=await listen(upstream); t.after(()=>target.close());
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{req.session=req.get('x-test-role')?{admin:{role:req.get('x-test-role'),tfa:true}}:{};next();});
  app.use('/outlook',createRouter('http://127.0.0.1:'+target.address().port));
  const server=await listen(app);t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(base+'/outlook/api/pool/pick')).status,401);
  assert.equal((await fetch(base+'/outlook/api/pool/pick',{headers:{'x-test-role':'admin'}})).status,403);
  const headers={'x-test-role':'superadmin','content-type':'application/json'};
  assert.equal((await fetch(base+'/outlook',{headers,redirect:'manual'})).headers.get('location'),'/outlook/');
  assert.equal((await fetch(base+'/outlook/api/pool/pick',{method:'POST',headers:{...headers,origin:'https://other.example'},body:'{}'})).status,403);
  const reply=await fetch(base+'/outlook/api/pool/pick',{method:'POST',headers,body:JSON.stringify({for:'steam'})});
  assert.deepEqual(await reply.json(),{path:'/api/pool/pick',body:{for:'steam'}});
});

test('one pool preserves exclusive reservations and writes the configured ledger', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'outlook-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const accounts=path.join(dir,'accounts.txt'),usage=path.join(dir,'usage.json');
  fs.writeFileSync(accounts,'first@outlook.com|secret-password|secret-refresh|client-public\nsecond@outlook.com|secret-password|secret-refresh|client-public\n');
  fs.writeFileSync(usage,JSON.stringify({'first@outlook.com':{soop:{status:'ok'}}}));
  const child=spawn(process.execPath,[path.join(__dirname,'../scripts/mail-dashboard.js')],{env:{...process.env,PORT:'43991',OUTLOOK_ACCOUNTS_FILE:accounts,OUTLOOK_USAGE_FILE:usage},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(Error('reader exited '+code)));child.stderr.once('data',d=>reject(Error(String(d))));});
  const base='http://127.0.0.1:43991';
  const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const [one,two]=await Promise.all([post('/api/pool/pick',{for:'steam'}),post('/api/pool/pick',{for:'steam'})]);
  assert.equal([one,two].filter(x=>x.ok).length,1);
  const pick=[one,two].find(x=>x.ok);assert.equal(pick.email,'second@outlook.com');
  assert.equal((await post('/api/pool/pick',{for:'epic'})).ok,false);
  await post('/api/pool/release',{email:pick.email,for:'steam',status:'ok'});
  assert.equal(JSON.parse(fs.readFileSync(usage))[pick.email].steam.exclusive,true);
  const html=await fetch(base+'/').then(r=>r.text());assert.ok(html.includes("fetch('api/accounts')"));
  const safe=await fetch(base+'/api/accounts').then(r=>r.text());assert.ok(!safe.includes('secret-password'));assert.ok(!safe.includes('secret-refresh'));
});

test('buyer reader retries a consent scope error with the vendor granted scopes', async () => {
  const vm=require('node:vm');
  const source=fs.readFileSync(path.join(__dirname,'../scripts/epic-mail-proxy.js'),'utf8');
  const scopes=[];
  const context={URLSearchParams,Date,Map,SCOPES:'offline_access Mail.ReadWrite User.Read',AUTHORITY_TOKEN:'https://test.invalid/token',tokenCache:new Map(),fetchJson:async(_url,opts)=>{
    scopes.push(new URLSearchParams(opts.body).get('scope'));
    if(scopes.length===1)throw Error('AADSTS70000: consent mismatch');
    return {access_token:'test-access',expires_in:3600};
  }};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function accessTokenFor('),source.indexOf('\nfunction shape(')),context);
  assert.equal(await context.accessTokenFor({email:'fixture@outlook.com',clientId:'fixture',refreshToken:'fixture'}),'test-access');
  assert.deepEqual(scopes,['offline_access Mail.ReadWrite User.Read','https://graph.microsoft.com/.default']);
});

test('Riot reserves only unused mail and remains exclusive to every other purpose', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'outlook-riot-test-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const accounts = path.join(dir,'accounts.txt'), usage = path.join(dir,'usage.json');
  fs.writeFileSync(accounts,['used','steam','free'].map(name => `${name}@outlook.com|password|refresh|client`).join('\n') + '\n');
  fs.writeFileSync(usage,JSON.stringify({'used@outlook.com':{soop:{status:'ok'}},'steam@outlook.com':{steam:{status:'ok',exclusive:true}}}));
  const child = spawn(process.execPath,[path.join(__dirname,'../scripts/mail-dashboard.js')],{
    env:{...process.env,PORT:'43992',OUTLOOK_ACCOUNTS_FILE:accounts,OUTLOOK_USAGE_FILE:usage},stdio:['ignore','pipe','pipe']});
  t.after(() => child.kill());
  await new Promise((resolve,reject) => {child.stdout.once('data',resolve);child.once('exit',code => reject(Error('reader exited '+code)));child.stderr.once('data',d => reject(Error(String(d))));});
  const base = 'http://127.0.0.1:43992';
  const post = (route,body) => fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const caps = await fetch(base+'/api/pool/capabilities').then(r=>r.json());
  assert.equal(caps.authority,'cloud');assert.ok(caps.exclusivePurposes.includes('riot'));
  const results = await Promise.all([post('/api/pool/pick',{for:'riot'}),post('/api/pool/pick',{for:'riot'})]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>r.ok).email,'free@outlook.com');
  await post('/api/pool/release',{email:'free@outlook.com',for:'riot',status:'ok'});
  assert.equal(JSON.parse(fs.readFileSync(usage))['free@outlook.com'].riot.exclusive,true);
  assert.equal((await post('/api/pool/pick',{for:'soop'})).ok,false);
  assert.equal((await post('/api/pool/pick',{for:'epic'})).ok,false);
});
