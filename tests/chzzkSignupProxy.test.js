const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const {readProxy,prepareProxy,verifyBrowser}=require('../tools/chzzk-signup/proxy.cjs');
const proxy=()=>({scheme:'http',host:'proxy.example',port:8080,username:'private-user',password:'private-password',country:'US',location:{ip:'203.0.113.8',country:'US'},ticket:'test-ticket',expiresAt:new Date(Date.now()+600000).toISOString()});
test('residential config replaces the old sticky session while preserving the selected country',()=>{
  const p=readProxy({env:{RES_HOST:'rp.scrapegw.com',RES_PORT:'8080',RES_USER:'customer-country-jp-session-old-lifetime-99',RES_PASS:'secret'},filename:'/not-present'});
  assert.equal(p.country,'JP');assert.match(p.username,/customer-country-jp-session-[a-f0-9]{16}-lifetime-30$/);assert.equal(p.password,'secret');
});
test('proxy errors never expose credentials and a different exit country is rejected',async()=>{
  assert.throws(()=>readProxy({env:{},filename:'/not-present'}),/Configure/);
  await assert.rejects(prepareProxy({read:proxy,lookup:async()=>({ip:'203.0.113.8',country:'JP'})}),/did not match/);
});
test('browser proof must match the prepared IP, country, ticket and unexpired session',()=>{
  const p=proxy();assert.equal(verifyBrowser(p,p.ticket,p.location).country,'US');
  for(const [ticket,location] of [['wrong',p.location],[p.ticket,{...p.location,ip:'203.0.113.9'}],[p.ticket,{...p.location,country:'JP'}]])assert.throws(()=>verifyBrowser(p,ticket,location),/verification failed/);
  p.expiresAt=new Date(0).toISOString();assert.throws(()=>verifyBrowser(p,p.ticket,p.location),/verification failed/);
});
test('5sim cannot be purchased before browser proxy verification, including after expiry',async t=>{
  const {Engine}=require('../tools/chzzk-signup/engine.cjs'),{LocalVault}=require('../tools/chzzk-signup/vault.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chzzk-proxy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const engine=new Engine({vault:new LocalVault(dir),provider:{prices:async()=>{throw Error('Provider must not be reached');}}}),s=engine.start({name:'Test Account',birthday:'19950102'});
  await assert.rejects(engine.number(s.id),/Verify the browser residential proxy/);s.proxyVerifiedAt=new Date().toISOString();s.signupProxy={expiresAt:new Date(0).toISOString()};
  await assert.rejects(engine.number(s.id),/Verify the browser residential proxy/);
});
test('authenticated proxy proof unlocks only its assigned signup and stays out of public state',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chzzk-proxy-api-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const p=proxy(),{app,token,vault}=require('../tools/chzzk-signup/local-app.cjs').createApp({dataDir:dir,port:0,provider:{},upload:null,prepareProxy:async()=>p});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(url,body)=>new Promise((resolve,reject)=>{
    const req=require('http').request({hostname:'127.0.0.1',port:server.address().port,path:'/api'+url,method:body?'POST':'GET',headers:{Host:'127.0.0.1:0','X-Local-Token':token,'Content-Type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text),text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const started=await request('/start',{name:'Proxy Test',birthday:'19950102'}),id=started.data.session.id;
  assert.equal((await request('/proxy/prepare',{sessionId:'another-signup'})).status,400);
  assert.equal((await request('/proxy/prepare',{sessionId:id})).status,200);
  assert.equal((await request('/proxy/verify',{sessionId:id,ticket:'wrong',location:p.location})).status,400);assert.equal(vault.data.sessions[0].proxyVerifiedAt,null);
  assert.equal((await request('/proxy/verify',{sessionId:id,ticket:p.ticket,location:p.location})).status,200);assert.ok(vault.data.sessions[0].proxyVerifiedAt);
  const state=await request('/state');assert.ok(!state.text.includes(p.username));assert.ok(!state.text.includes(p.password));assert.ok(!fs.readFileSync(vault.filename,'utf8').includes(p.password));
});
function extension(){
  const store={},local={},trace=[],listeners={},p=proxy();let setting={levelOfControl:'controllable_by_this_extension',value:{mode:'system'}};
  const event=name=>({addListener:fn=>{listeners[name]=fn;}});
  const chrome={storage:{session:{get:async()=>structuredClone(store),set:async data=>Object.assign(store,structuredClone(data)),remove:async key=>{for(const k of Array.isArray(key)?key:[key])delete store[k];}},local:{get:async()=>structuredClone(local),set:async data=>Object.assign(local,structuredClone(data)),remove:async key=>{delete local[key];}}},
    extension:{isAllowedIncognitoAccess:async()=>true},proxy:{settings:{get:async()=>structuredClone(setting),set:async options=>{trace.push('proxy:set:'+options.scope);setting={levelOfControl:'controlled_by_this_extension',value:options.value};},clear:async options=>{trace.push('proxy:clear:'+options.scope);setting={levelOfControl:'controllable_by_this_extension',value:{mode:'system'}};}}},
    windows:{getAll:async()=>[],create:async options=>{trace.push('window:'+options.url);return{id:3,tabs:[{id:7}]};},update:async()=>{},remove:async id=>{trace.push('window:close:'+id);},onRemoved:event('windowRemoved')},
    tabs:{get:async()=>({id:7,windowId:3,incognito:true,url:'about:blank'}),create:async options=>{trace.push('probe:'+options.url);return{id:8};},update:async(id,options)=>{if(options.url)trace.push('navigate:'+id+':'+options.url);},remove:async id=>trace.push('tab:close:'+id),sendMessage:async()=>{trace.push('form');return{};}},
    runtime:{onMessage:event('message'),getManifest:()=>({version:'test'})},action:{onClicked:event('action')},webRequest:{onAuthRequired:event('auth'),onCompleted:event('complete'),onErrorOccurred:event('error')}};
  const context=vm.createContext({chrome,URL,Date,AbortSignal,fetch:async(url,options)=>{
    trace.push('api:'+url.slice(url.indexOf('/api/')));let data={};
    if(url.endsWith('/identity'))data={identity:{manual:false}};
    if(url.endsWith('/proxy/prepare'))data={proxy:p};
    if(url.endsWith('/proxy/verify')){const body=JSON.parse(options.body);try{data=verifyBrowser(p,body.ticket,body.location);}catch{return{ok:false,json:async()=>({ok:false,error:'Proxy mismatch'})};}}
    return{ok:true,json:async()=>({ok:true,...data})};
  }});
  vm.runInContext(fs.readFileSync(require.resolve('../extension/chzzk-signup/background.js'),'utf8'),context);
  return{store,local,trace,proxy:p,setting:value=>{setting=value;},command:type=>vm.runInContext(`handle(${JSON.stringify({type,token:'local-token',...(type==='proxy-test'?{}:{sessionId:'signup-1'})})},{tab:{url:'http://127.0.0.1:4109/'}})`,context),
    observe:(location=p.location,tabId=8)=>vm.runInContext(`handle(${JSON.stringify({type:'proxy-observed',location})},${JSON.stringify({url:'https://ipwho.is/',frameId:0,tab:{id:tabId,windowId:3,incognito:true}})})`,context),
    tick:()=>vm.runInContext('load().then(tick)',context),auth:details=>new Promise(resolve=>listeners.auth(details,resolve))};
}
test('Naver opens only after the private browser proves the same residential exit',async()=>{
  const e=extension();await e.command('open');assert.ok(e.trace.includes('window:about:blank'));assert.ok(e.trace.includes('proxy:set:incognito_session_only'));assert.ok(e.trace.includes('navigate:8:https://ipwho.is/'));assert.ok(!e.trace.some(t=>t.includes('nid.naver.com')));
  await e.observe();assert.ok(e.trace.includes('navigate:7:https://nid.naver.com/account/signup/term?lang=en_US&realname=N'));assert.equal(e.store.active.proxyVerified,true);
});
test('a mismatched or unassigned browser proof never opens Naver',async()=>{
  const e=extension();await e.command('open');assert.equal((await e.observe(e.proxy.location,99)).ok,false);
  await assert.rejects(e.observe({...e.proxy.location,ip:'203.0.113.9'}),/Proxy mismatch/);assert.equal(e.store.active.paused,true);assert.ok(!e.trace.some(t=>t.includes('nid.naver.com')));
});
test('a changed proxy stops form actions and purchases before identity retrieval',async()=>{
  const e=extension();await e.command('open');await e.observe();const before=e.trace.length;e.setting({levelOfControl:'controlled_by_other_extensions',value:{mode:'direct'}});
  await assert.rejects(e.tick(),/private proxy changed/);assert.equal(e.trace.length,before);
});
test('proxy authentication is restricted to the assigned tabs and exact proxy challenger',async()=>{
  const e=extension();await e.command('open');const request={requestId:'r',tabId:8,isProxy:true,challenger:{host:e.proxy.host,port:e.proxy.port}};
  assert.deepEqual(JSON.parse(JSON.stringify(await e.auth(request))),{authCredentials:{username:e.proxy.username,password:e.proxy.password}});
  for(const r of [{...request,tabId:99},{...request,isProxy:false},{...request,challenger:{host:'other.example',port:8080}}])assert.deepEqual(JSON.parse(JSON.stringify(await e.auth(r))),{});
});
test('a proxy-only test closes its window and clears all helper credentials without creating an account',async()=>{
  const e=extension();await e.command('proxy-test');await e.observe();assert.equal(e.store.active,undefined);assert.equal(e.local.recovery,undefined);assert.ok(e.trace.includes('window:close:3'));assert.ok(e.trace.includes('proxy:clear:incognito_session_only'));assert.ok(!e.trace.some(t=>t.includes('/identity')||t.includes('nid.naver.com')));
});
test('close clears stale browser credentials and recovery even when no signup exists on the server',async()=>{
  const e=extension();e.store.active={windowId:3,captureCookies:[{value:'private-cookie'}]};e.local.recovery={id:'removed-signup'};await e.command('close');assert.equal(e.store.active,undefined);assert.equal(e.local.recovery,undefined);
});
