const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {createApp}=require('../tools/steam-signup/local-app.cjs');
const {verificationLink}=require('../tools/steam-signup/mail.cjs');
const {LocalVault}=require('../tools/epic-signup/local-vault.cjs');
const valid='https://store.steampowered.com/account/newaccountverification?stoken='+ 'a'.repeat(80)+'&creationid=123456';
test('verification accepts only a fresh Steam account verification URL',()=>{
 const m={from:{emailAddress:{address:'noreply@steampowered.com'}},subject:'New Steam Account Email Verification',receivedDateTime:'2026-11-01T12:01:00Z',body:valid.replace('&','&amp;')};
 assert.equal(verificationLink([m],'2026-11-01T12:00:00Z'),valid);
 for(const change of [{receivedDateTime:'2026-11-01T11:59:00Z'},{receivedDateTime:'invalid'},{from:{emailAddress:{address:'noreply@steampowered.com.attacker.test'}}},{subject:'Steam login code'},{body:valid.replace('store.steampowered.com','attacker.test')}])assert.equal(verificationLink([{...m,...change}],'2026-11-01T12:00:00Z'),null);
});
test('local runtime authenticates, serializes reservation, resumes, and saves only a completed signup',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'steam-test-'));let reservations=0,completeCalls=0;
 const mail={status:async()=>({inboxes:3,steamUsed:0}),reserve:async()=>{reservations++;await new Promise(r=>setTimeout(r,20));return 'test@outlook.com';},verify:async()=>valid,complete:async()=>{completeCalls++;if(completeCalls===1)throw Error('offline');}};
 const proxy={host:'rp.scrapegw.com',port:8080,scheme:'http',username:'test',password:'proxy-secret',location:{country:'US',ip:'203.0.113.5',city:'Example City'},expiresAt:new Date(Date.now()+600000).toISOString()};
 const prepare=async()=>proxy;
 let finishCountryCheck;
 const {app,vault,token}=createApp({dataDir:dir,mail,port:4108,prepare,checkStoreCountry:()=>new Promise(resolve=>{finishCountryCheck=resolve;})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const req=(p,body,headers={})=>new Promise((resolve,reject)=>{const r=require('http').request(base+p,{method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4108','X-Local-Token':token,'Content-Type':'application/json',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(text)}));});r.on('error',reject);r.end(body===undefined?undefined:JSON.stringify(body));});
 assert.equal((await req('/api/state',undefined,{'X-Local-Token':'bad'})).status,403);
 assert.equal((await req('/api/state',undefined,{host:'attacker.test'})).status,403);
 assert.equal((await req('/api/start',{}, {origin:'https://attacker.test'})).status,403);
 const ticket=async()=>{const p=await(await req('/api/proxy/prepare',{country:'US'})).json();return {ticket:p.ticket,browserLocation:{country:'US',ip:'203.0.113.5'},sampleContact:true,autoSubmit:true};};
 assert.equal((await req('/api/start',{})).status,503);assert.equal(reservations,0);
 const wrong=await ticket();wrong.browserLocation.ip='203.0.113.99';assert.equal((await req('/api/start',wrong)).status,503);assert.equal(reservations,0);
 const first=await ticket(),second=await ticket();
 const results=await Promise.all([req('/api/start',first),req('/api/start',second)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(reservations,1);
 const {session}=await results.find(r=>r.status===200).json();
 assert.equal((await req('/api/start',{})).status,409);
 const resume=await(await req('/api/resume',await ticket())).json();assert.equal(resume.session.password,session.password);assert.equal(reservations,1);
 assert.equal(session.automation.autoSubmit,true);assert.equal(session.automation.autoAcceptAgreement,true);assert.equal(session.automation.autoClickCaptcha,true);
 assert.equal(session.contact.country,'US');assert.equal(session.contact.smsCapable,false);
 assert.equal((await req('/api/session/'+session.id+'/country',{country:'US'})).status,200);
 const state=await(await req('/api/state')).json();assert.equal(JSON.stringify(state).includes(session.password),false);
 assert.equal((await req('/api/session/'+session.id+'/complete',{url:'https://store.steampowered.com/'})).status,400);
 assert.equal(vault.data.accounts.length,0);
 const url='/api/session/'+session.id+'/complete',body={url:'https://store.steampowered.com/?created_account=1'};
 assert.equal((await req(url,body)).status,503);assert.equal(vault.data.accounts.length,1);assert.equal(vault.data.accounts[0].mailPending,true);
 assert.equal((await req(url,body)).status,200);assert.equal(vault.data.accounts.length,1);assert.equal(completeCalls,2);
 assert.equal(vault.data.accounts[0].mailPending,false);assert.equal(vault.data.accounts[0].proxy,undefined);assert.equal(vault.data.accounts[0].regionMatch,true);assert.equal(vault.data.accounts[0].storeCountry,null);
 assert.equal(fs.readFileSync(path.join(dir,'accounts.vault'),'utf8').includes(session.password),false);
 assert.equal(new LocalVault(dir).data.accounts[0].password,session.password);
 assert.equal((await req('/api/accounts/'+session.id+'/store-country',{}, {'X-Local-Token':'bad'})).status,403);
 assert.equal((await req('/api/accounts/missing/store-country',{})).status,404);
 assert.equal((await req('/api/accounts/'+session.id+'/store-country',{})).status,202);
 assert.equal((await req('/api/accounts/'+session.id+'/store-country',{})).status,409);
 const checking=await(await req('/api/state')).json();assert.equal(checking.accounts[0].storeCountryCheck.state,'checking');assert.equal(checking.accounts[0].storeCountry,null);
 finishCountryCheck({country:'JP',source:'steam-wallet-country',checkedAt:'2026-11-03T03:00:00Z'});
 await new Promise(resolve=>setImmediate(resolve));
 const checked=await(await req('/api/state')).json();assert.equal(checked.accounts[0].storeCountry,'JP');assert.equal(checked.accounts[0].country,'US');assert.equal(checked.accounts[0].storeCountryCheckedAt,'2026-11-03T03:00:00Z');assert.equal(checked.accounts[0].storeCountryCheck.state,'done');
 assert.equal(new LocalVault(dir).data.accounts[0].storeCountry,'JP');
 assert.equal((await req('/api/accounts/'+session.id+'/store-country',{})).status,202);
 finishCountryCheck({country:'',source:'steam-wallet-country',checkedAt:'2026-11-03T03:01:00Z'});
 await new Promise(resolve=>setImmediate(resolve));
 const failed=await(await req('/api/state')).json();assert.equal(failed.accounts[0].storeCountry,'JP');assert.equal(failed.accounts[0].storeCountryCheck.state,'error');assert.equal(failed.accounts[0].storeCountryCheckedAt,'2026-11-03T03:00:00Z');


 const revealed=await(await req('/api/accounts/'+session.id+'/reveal',{})).json();assert.equal(revealed.password,session.password);
});
test('worker refuses credential access from unassigned tabs and non-Steam pages',async()=>{
 const vm=require('vm');let listener;let state={active:{session:{id:'test',password:'secret'},tabId:7,windowId:3}};
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:f=>listener=f}},action:{onClicked:{addListener(){}}},storage:{session:{get:async()=>state}}};
 chrome.windows={onRemoved:{addListener(){}}};chrome.webRequest=Object.fromEntries(['onAuthRequired','onCompleted','onErrorOccurred'].map(k=>[k,{addListener(){}}]));
 const context={chrome,URL,Set,Map,fetch(){throw Error('unexpected fetch');},AbortSignal};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/background.js'),'utf8'),context);
 const call=sender=>new Promise(resolve=>listener({type:'identity'},sender,resolve));
 for(const sender of [{id:'extension-id',frameId:0,tab:{id:8},url:'https://store.steampowered.com/join/'},{id:'extension-id',frameId:0,tab:{id:7},url:'https://attacker.test/join/'},{id:'extension-id',frameId:1,tab:{id:7},url:'https://store.steampowered.com/join/'}])assert.equal((await call(sender)).ok,false);
 assert.equal((await call({id:'extension-id',frameId:0,tab:{id:7},url:'https://store.steampowered.com/join/'})).identity.password,'secret');
});
test('private-window prerequisites fail before consuming an inbox',async()=>{
 const vm=require('vm');let listener,fetches=0;
 const chrome={runtime:{id:'extension-id',onMessage:{addListener:f=>listener=f}},action:{onClicked:{addListener(){}}},extension:{isAllowedIncognitoAccess:cb=>cb(false)},windows:{getAll:async()=>[]},storage:{session:{get:async()=>({})}}};
 chrome.windows.onRemoved={addListener(){}};chrome.webRequest=Object.fromEntries(['onAuthRequired','onCompleted','onErrorOccurred'].map(k=>[k,{addListener(){}}]));
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/background.js'),'utf8'),{chrome,URL,Set,Map,AbortSignal,fetch:()=>{fetches++;throw Error('unexpected fetch');}});
 const sender={id:'extension-id',frameId:0,tab:{id:9},url:'http://127.0.0.1:4108/'};
 const call=()=>new Promise(resolve=>listener({type:'start'},sender,resolve));
 assert.match((await call()).error,/Allow in Incognito/);assert.equal(fetches,0);
 chrome.extension.isAllowedIncognitoAccess=cb=>cb(true);chrome.windows.getAll=async()=>[{incognito:true}];
 assert.match((await call()).error,/Close existing Incognito/);assert.equal(fetches,0);
});
test('region targeting replaces stale country/city/session and requires a matching observed exit',async()=>{
 const {targetProxy,prepareProxy,browserLocation,contactFor}=require('../tools/steam-signup/regions.cjs');
 const read=()=>({host:'rp.scrapegw.com',port:8080,username:'customer-country-us-state-old-city-old-session-stale-lifetime-5',password:'secret'});
 const p=targetProxy('JP',read);assert.match(p.username,/^customer-country-jp-session-[a-f0-9]{16}-lifetime-30$/);
 assert.throws(()=>targetProxy('ZZ',read));assert.throws(()=>targetProxy('US',()=>({...read(),host:'other.test'})));
 let calls=0;
 const proxy=await prepareProxy('JP',{read,lookup:async()=>{calls++;return {country:calls===1?'US':'JP',ip:'203.0.113.4',city:'Tokyo'};}});
 assert.equal(calls,2);assert.equal(proxy.location.country,'JP');
 await assert.rejects(prepareProxy('JP',{read,lookup:async()=>({country:'US',ip:'203.0.113.4'})}),/did not match/);
 assert.throws(()=>browserLocation({country:'JP',ip:'203.0.113.9'},proxy),/verification failed/);
 assert.equal(browserLocation({country:'JP',ip:'203.0.113.4'},proxy).source,'browser-proxy-ip');
 const sample=contactFor('JP',{city:'Tokyo'});assert.equal(sample.country,'JP');assert.equal(sample.smsCapable,false);assert.match(sample.address,/Tokyo/);assert.match(sample.address,/fictional/);
});
test('proxy authentication never sends credentials to an origin challenge or another tab/proxy',async()=>{
 const vm=require('vm');let auth;
 const state={pending:{tabId:7,proxy:{host:'rp.scrapegw.com',port:8080,username:'user',password:'secret'}}};
 const chrome={runtime:{id:'ext',onMessage:{addListener(){}}},action:{onClicked:{addListener(){}}},windows:{onRemoved:{addListener(){}}},storage:{session:{get:async()=>state}},webRequest:{onAuthRequired:{addListener:f=>auth=f},onCompleted:{addListener(){}},onErrorOccurred:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/background.js'),'utf8'),{chrome,Map,Set,URL,AbortSignal});
 const base={requestId:'1',isProxy:true,tabId:7,challenger:{host:'rp.scrapegw.com',port:8080}};
 const call=details=>new Promise(resolve=>auth(details,resolve));
 for(const d of [{...base,isProxy:false},{...base,tabId:8},{...base,challenger:{host:'other.test',port:8080}}])assert.equal((await call(d)).authCredentials,undefined);
 assert.equal((await call(base)).authCredentials.password,'secret');await call(base);assert.equal((await call(base)).cancel,true);
});
test('form filling runs Steam inline keyup validation and the status banner cannot intercept clicks',async()=>{
 const vm=require('vm');let checks=0,badge;
 class Input{
  constructor(type,name){this.type=type;this.name=name;this.id=name;this._value='';}
  get value(){return this._value;}set value(v){this._value=v;}
  getClientRects(){return [{}];}
  getAttribute(){return null;}
  dispatchEvent(event){if(this.name==='password'&&event.type==='keyup'&&this.value.length>=8)checks++;}
 }
 const fields=[new Input('text','accountname'),new Input('password','password'),new Input('password','reenter_password')];
 const identity={username:'fixture_account',password:'ComplexFixture123!'};
 const document={querySelectorAll:()=>fields,querySelector:()=>null,createElement:()=>badge={style:{},isConnected:false},dispatchEvent(){},body:{innerText:'',append(b){b.isConnected=true;}}};
 class Event{constructor(type,options){this.type=type;Object.assign(this,options);}}
 await vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/content.js'),'utf8'),{document,chrome:{runtime:{sendMessage:async()=>({ok:true,identity})}},location:{href:'https://store.steampowered.com/join/completesignup?creationid=1',pathname:'/join/completesignup'},HTMLInputElement:Input,Event,CustomEvent:Event,KeyboardEvent:Event,setInterval(){}});
 assert.equal(checks,1);assert.equal(fields[1].value,identity.password);assert.equal(fields[2].value,identity.password);assert.match(badge.style.cssText,/pointer-events:none/);
});
test('completion recognizes tracking parameters and sends canonical success evidence to the local app',async()=>{
 const vm=require('vm');let listener,cleared=false,closed=false;const requests=[];
 const state={localToken:'test',active:{session:{id:'fixture'},tabId:7,windowId:3}};
 const chrome={runtime:{id:'ext',onMessage:{addListener:f=>listener=f}},action:{onClicked:{addListener(){}}},storage:{session:{get:async()=>state,remove:async()=>{}}},windows:{onRemoved:{addListener(){}},remove:async()=>{closed=true;}},proxy:{settings:{clear:async()=>{cleared=true;}}},webRequest:Object.fromEntries(['onAuthRequired','onCompleted','onErrorOccurred'].map(k=>[k,{addListener(){}}]))};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/background.js'),'utf8'),{chrome,Map,Set,URL,AbortSignal,fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true})};}});
 const call=url=>new Promise(resolve=>listener({type:'complete'},{id:'ext',frameId:0,tab:{id:7},url},resolve));
 assert.equal((await call('https://store.steampowered.com/?created_account=0')).ok,false);assert.equal(requests.length,0);
 assert.equal((await call('https://store.steampowered.com/?created_account=1&snr=signup_tracking')).ok,true);
 assert.equal(requests[0].body.url,'https://store.steampowered.com/?created_account=1');assert.equal(closed,true);assert.equal(cleared,true);
});
test('automatic registration waits for a real CAPTCHA response and submits each form once',()=>{
 const {create}=require('../extension/steam-signup/flow.js');let time=0,submitClicks=0,agreementClicks=0;
 const agree={checked:false,click(){this.checked=true;agreementClicks++;}};
 const button={disabled:false,getAttribute(){return null;},getClientRects(){return [{}];},click(){submitClicks++;}};
 const document={querySelector:s=>({'#i_agree_check':agree,'#createAccountButton':button}[s]||null)};
 const flow=create({document,now:()=>time});
 assert.equal(flow.registration({allowed:false,countryReady:true,captchaToken:'token'}).state,'manual');assert.equal(agreementClicks,0);
 assert.equal(flow.registration({allowed:true,countryReady:false,captchaToken:'token'}).state,'waiting-country');
 assert.equal(flow.registration({allowed:true,countryReady:true,captchaToken:''}).state,'waiting-captcha');assert.equal(agreementClicks,1);assert.equal(submitClicks,0);
 assert.equal(flow.registration({allowed:true,countryReady:true,captchaToken:'real-token'}).state,'waiting-validation');
 time=1001;assert.equal(flow.registration({allowed:true,countryReady:true,captchaToken:'real-token'}).state,'submitted');
 time=5000;flow.registration({allowed:true,countryReady:true,captchaToken:'real-token'});assert.equal(submitClicks,1);assert.equal(agreementClicks,1);
 time=92002;assert.equal(flow.registration({allowed:true,countryReady:true,captchaToken:'real-token'}).state,'failed');assert.equal(submitClicks,1);
});
test('automatic Done waits for both Steam availability checks and never resubmits an error',()=>{
 const {create}=require('../extension/steam-signup/flow.js');let time=0,nameReady=false,passwordReady=false,error='',clicks=0;
 const name={getClientRects(){return nameReady?[{}]:[];},get innerText(){return nameReady?'Available':'';}};
 const password={classList:{contains:c=>passwordReady&&c==='good'}};
 const problem={getClientRects(){return error?[{}]:[];},get innerText(){return error;}};
 const done={innerText:'Done',getClientRects(){return [{}];},getAttribute(){return null;},click(){clicks++;}};
 const document={querySelector:s=>({'#accountname_availability':name,'#password_tag':password,'#error_display':problem}[s]),querySelectorAll:()=>[done]};
 const flow=create({document,now:()=>time});const step=()=>flow.credentials({allowed:true,valuesMatch:true});
 assert.equal(step().state,'waiting-validation');nameReady=true;time=4000;assert.equal(step().state,'waiting-validation');assert.equal(clicks,0);
 passwordReady=true;assert.equal(step().state,'waiting-validation');time=5001;assert.equal(step().state,'submitted');assert.equal(clicks,1);
 error='The password you entered is not allowed';assert.equal(step().state,'failed');assert.equal(clicks,1);
});
test('CAPTCHA iframe authorization is restricted to the assigned checkbox and returns no credentials',async()=>{
 const vm=require('vm');let listener;const state={active:{session:{password:'account-secret',automation:{autoClickCaptcha:true}},tabId:7}};
 const chrome={runtime:{id:'ext',onMessage:{addListener:f=>listener=f}},action:{onClicked:{addListener(){}}},storage:{session:{get:async()=>state,set:async()=>{}}},windows:{onRemoved:{addListener(){}}},webRequest:Object.fromEntries(['onAuthRequired','onCompleted','onErrorOccurred'].map(k=>[k,{addListener(){}}]))};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/background.js'),'utf8'),{chrome,Map,Set,URL,URLSearchParams,AbortSignal});
 const url='https://newassets.hcaptcha.com/captcha/v1/widget.html#frame=checkbox&host=store.steampowered.com&sitekey=e18a349a-46c2-46a0-87a8-74be79345c92';
 const call=(url,tabId=7)=>new Promise(resolve=>listener({type:'captcha-frame'},{id:'ext',frameId:2,tab:{id:tabId},url},resolve));
 assert.equal((await call(url,9)).ok,false);assert.equal((await call(url.replace('frame=checkbox','frame=challenge'))).ok,false);
 assert.equal((await call(url.replace('host=store.steampowered.com','host=other.test'))).ok,false);
 const result=await call(url);assert.equal(result.autoClick,true);assert.equal(JSON.stringify(result).includes('account-secret'),false);assert.equal(state.active.captchaReady,true);
});
test('CAPTCHA checkbox automation never interacts with puzzle frames and clicks only once',async()=>{
 const vm=require('vm');let tick,clicks=0,messages=0;
 const source=fs.readFileSync(path.join(__dirname,'../extension/steam-signup/captcha-checkbox.js'),'utf8');
 const box={getClientRects:()=>[{}],getAttribute:()=> 'false',click(){clicks++;}};
 const context={location:{hash:'#frame=challenge&host=store.steampowered.com'},URLSearchParams,document:{getElementById:()=>box},chrome:{runtime:{sendMessage:async()=>{messages++;return {ok:true,autoClick:true};}}},setInterval:f=>{tick=f;return 1;},clearInterval(){}};
 await vm.runInNewContext(source,context);assert.equal(clicks,0);assert.equal(messages,0);
 context.location.hash='#frame=checkbox&host=store.steampowered.com';await vm.runInNewContext(source,context);tick();tick();assert.equal(clicks,1);
});
test('age modal progresses with hidden email fields and verification wait skips submission timeout',async()=>{
 const vm=require('vm');const {create}=require('../extension/steam-signup/flow.js');
 for(const waiting of [false,true]){
  let ageClicks=0,verification=0;
  const age={innerText:'I am 16 years of age or older',getClientRects:()=>[{}],getAttribute:()=>null,click(){ageClicks++;}};
  const document={body:{innerText:waiting?'Waiting for you to verify your email address':'Please tell us your age',append(){}},querySelectorAll:s=>s==='input'?[]:waiting?[]:[age],querySelector:()=>null,createElement:()=>({style:{}})};
  const flow=create({document});flow.registration=()=>{throw Error('must not revisit submitted form');};
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/content.js'),'utf8'),{document,SteamSignupFlow:{create:()=>flow},chrome:{runtime:{sendMessage:async m=>{if(m.type==='verification'){verification++;return {ok:true,opened:true};}return {ok:true,identity:{automation:{autoSubmit:true}}};}}},location:{pathname:'/join/'},setInterval(){}});
  assert.equal(ageClicks,waiting?0:1);assert.equal(verification,waiting?1:0);
 }
});
test('page-context click bridge allows only visible routine Steam controls',()=>{
 const vm=require('vm');let listener,clicks=0;
 class Anchor{constructor(label,href,visible=true){this.innerText=label;this.href=href;this.visible=visible;}getAttribute(){return this.href;}getClientRects(){return this.visible?[{}]:[];}click(){clicks++;}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/page-click.js'),'utf8'),{document:{addEventListener:(name,f)=>{if(name==='steam-signup-routine-click')listener=f;}},HTMLAnchorElement:Anchor});
 for(const el of [new Anchor('I am under 16 years of age','javascript:GetParentalConsentEmail();'),new Anchor('Done','https://other.test'),new Anchor('Done','javascript:CreateAccount();',false)])listener({target:el});
 assert.equal(clicks,0);listener({target:new Anchor('I am 16 years of age or older','javascript:StartCreationSession();')});assert.equal(clicks,1);
});
test('resumed verification ignores mail from the previous creation attempt',async()=>{
 const vm=require('vm');const messages=[{from:{emailAddress:{address:'noreply@steampowered.com'}},subject:'New Steam Account Email Verification',receivedDateTime:'2026-11-01T12:01:00Z',body:valid}];
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../tools/steam-signup/mail.cjs'),'utf8'),{module,URL,require:()=>({create:()=>({post:async()=>({data:{ok:true,messages}})})})});
 const mail=module.exports.createMail();const session={email:'fixture@outlook.com',createdAt:'2026-11-01T12:00:00Z',lastResumedAt:'2026-11-01T12:02:00Z'};
 assert.equal(await mail.verify(session),null);messages.push({...messages[0],receivedDateTime:'2026-11-01T12:03:00Z'});assert.equal(await mail.verify(session),valid);
});
test('page keyboard bridge invokes inline validation without passing credentials',()=>{
 const vm=require('vm');let handler,events=0;
 class Input{constructor(id){this.id=id;}getClientRects(){return [{}];}dispatchEvent(e){assert.equal(e.type,'keyup');events++;}}
 class Key{constructor(type){this.type=type;}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/steam-signup/page-click.js'),'utf8'),{document:{addEventListener:(name,f)=>{if(name==='steam-signup-field-keyup')handler=f;}},HTMLInputElement:Input,KeyboardEvent:Key});
 handler({target:new Input('unrelated')});assert.equal(events,0);handler({target:new Input('password')});assert.equal(events,1);
});
test('strong accepted passwords can finish while Steam hides the status tag',()=>{
 const {create}=require('../extension/steam-signup/flow.js');let time=0,clicks=0;
 const name={innerText:'Available',getClientRects:()=>[{}]},tag={classList:{contains:()=>false}};
 const done={innerText:'Done',getClientRects:()=>[{}],getAttribute:()=>null,click(){clicks++;}};
 const flow=create({now:()=>time,document:{querySelector:s=>({'#accountname_availability':name,'#password_tag':tag}[s]),querySelectorAll:()=>[done]}});
 const step=passwordAvailable=>flow.credentials({allowed:true,valuesMatch:true,passwordAvailable});
 assert.equal(step(false).state,'waiting-validation');assert.equal(step(true).state,'waiting-validation');time=1001;assert.equal(step(true).state,'submitted');assert.equal(clicks,1);
});
test('Steam requires cloud authority before reserving an exclusive mailbox',async t=>{
 const http=require('http');let authority='local',picks=0;
 const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');
  if(req.url==='/api/pool/capabilities')return res.end(JSON.stringify({authority,exclusivePurposes:['steam']}));
  if(req.url==='/api/accounts')return res.end('[]');
  if(req.url==='/api/pool/pick'){picks++;return res.end(JSON.stringify({ok:true,email:'fixture@outlook.com'}));}
  res.statusCode=404;res.end('{}');
 }).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const mail=require('../tools/steam-signup/mail.cjs').createMail('http://127.0.0.1:'+server.address().port);
 assert.equal((await mail.status()).exclusiveReady,false);
 await assert.rejects(mail.reserve(),/cloud Outlook pool/);assert.equal(picks,0);
 authority='cloud';assert.equal((await mail.status()).exclusiveReady,true);
 assert.equal(await mail.reserve(),'fixture@outlook.com');assert.equal(picks,1);
});
