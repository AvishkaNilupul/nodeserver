const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const {createApp} = require('../tools/valorant-signup/local-app.cjs');
const {createMail, verificationCode} = require('../tools/valorant-signup/mail.cjs');
const {LocalVault} = require('../tools/epic-signup/local-vault.cjs');

test('Riot mail parser requires trusted sender, fresh verification subject and unambiguous code', () => {
  const message = {from: {emailAddress: {address: 'noreply@mail.accounts.riotgames.com'}},
    subject: 'Verify your email', receivedDateTime: '2026-11-04T01:01:00Z', body: {content: '<p>Code: <b>123456</b></p>'}};
  const since = '2026-11-04T01:00:00Z';
  assert.equal(verificationCode([message], since), '123456');
  for (const change of [{from: {emailAddress: {address: 'noreply@riotgames.com.attacker.test'}}},
    {subject: 'Your receipt'}, {receivedDateTime: 'invalid'}, {receivedDateTime: '2026-11-03T00:00:00Z'},
    {body: '123456 or 654321'}]) assert.equal(verificationCode([{...message, ...change}], since), null);
  assert.equal(verificationCode([message], 'invalid'), null);
  assert.equal(verificationCode([message, {...message, receivedDateTime: '2026-11-04T01:02:00Z', body: '654321'}], since), '654321');
});

test('cloud Riot allocation fails before picking if authority or exclusivity is missing', async t => {
  const express = require('express'), app = express(); app.use(express.json());
  let caps = {authority: 'local', exclusivePurposes: ['riot']}, picks = 0;
  app.get('/api/pool/capabilities', (_q,r) => r.json(caps));
  app.post('/api/pool/pick', (q,r) => {picks++; assert.equal(q.body.for, 'riot'); r.json({ok: true, email: 'fixture@outlook.com'});});
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening',r)); t.after(() => server.close());
  const mail = createMail('http://127.0.0.1:' + server.address().port);
  await assert.rejects(mail.reserve(), /exclusive Riot/); assert.equal(picks, 0);
  caps = {authority: 'cloud', exclusivePurposes: ['epic','steam']};
  await assert.rejects(mail.reserve(), /exclusive Riot/); assert.equal(picks, 0);
  caps.exclusivePurposes.push('riot'); assert.equal(await mail.reserve(), 'fixture@outlook.com'); assert.equal(picks, 1);
});

test('runtime guards reservations, preserves interrupted identity and saves completion before mail failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valorant-test-')); let reserved = 0, finalized = 0;
  const mail = {status: async () => ({exclusiveReady: true, unused: 2}),
    reserve: async () => {reserved++; await new Promise(r => setTimeout(r,20)); return 'fixture@outlook.com';},
    verify: async () => '123456', complete: async () => {if (++finalized === 1) throw Error('offline');}};
  const proxy = country => ({host: 'rp.scrapegw.com', port: 8080, scheme: 'http', username: 'proxy-user', password: 'proxy-secret',
    location: {country, ip: '203.0.113.5'}, expiresAt: new Date(Date.now() + 600000).toISOString()});
  const {app, vault, token} = createApp({dataDir: dir, mail, prepare: async country => proxy(country)});
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening',r));
  t.after(() => {server.close(); fs.rmSync(dir,{recursive:true,force:true});});
  const request = (route, body, headers = {}) => new Promise((resolve,reject) => {
    const req = http.request({hostname: '127.0.0.1', port: server.address().port, path: route,
      method: body === undefined ? 'GET' : 'POST', headers: {host: '127.0.0.1:4110', 'X-Local-Token': token, 'Content-Type': 'application/json', ...headers}}, response => {
      let text = ''; response.on('data', b => text += b); response.on('end', () => resolve({status: response.statusCode, text, json: () => JSON.parse(text)}));
    }); req.on('error',reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request('/api/state', undefined, {'X-Local-Token':'wrong'})).status,403);
  assert.equal((await request('/api/state', undefined, {host:'attacker.test'})).status,403);
  assert.equal((await request('/api/start', {}, {origin:'https://attacker.test'})).status,403);
  const ticket = async (country = 'JP') => ({ticket: (await request('/api/proxy/prepare',{country})).json().ticket,
    browserLocation: {country, ip: '203.0.113.5'}});
  assert.equal((await request('/api/start', {})).status,503); assert.equal(reserved,0);
  const wrong = await ticket(); wrong.browserLocation.ip = '203.0.113.6';
  assert.equal((await request('/api/start', wrong)).status,503); assert.equal(reserved,0);
  assert.equal((await request('/api/proxy/prepare',{country:'KR'})).status,503);
  const first = await ticket(), second = await ticket();
  const result = await Promise.all([request('/api/start',first), request('/api/start',second)]);
  assert.deepEqual(result.map(r => r.status).sort(),[200,409]); assert.equal(reserved,1);
  const session = result.find(r => r.status === 200).json().session;
  assert.equal(session.expectedShard,'AP'); assert.equal(session.country,null); assert.equal(session.shard,null);
  assert.equal((await request('/api/resume',await ticket('US'))).status,503);
  const resumed = (await request('/api/resume',await ticket())).json().session;
  assert.equal(resumed.password,session.password); assert.equal(resumed.username,session.username); assert.equal(reserved,1);
  const state = await request('/api/state'); assert.ok(!state.text.includes(session.password)); assert.ok(!state.text.includes('proxy-secret'));
  const route = '/api/session/' + session.id + '/complete';
  for (const evidence of [{source:'riot-signup-response',type:'success',username:'other'},
    {source:'redirect',type:'success',username:session.username}, {source:'riot-signup-response',type:'verification',username:session.username}]) {
    assert.equal((await request(route,{evidence})).status,400); assert.equal(vault.data.accounts.length,0);
  }
  const evidence = {source:'riot-signup-response',type:'success',username:session.username};
  assert.equal((await request(route,{evidence})).status,503); assert.equal(vault.data.accounts.length,1);
  assert.equal(vault.data.accounts[0].mailPending,true);
  assert.equal((await request(route,{evidence})).status,200); assert.equal(vault.data.accounts.length,1);
  assert.equal(vault.data.accounts[0].mailPending,false); assert.equal(vault.data.accounts[0].regionVerified,false);
  assert.equal(vault.data.accounts[0].rankedReady,false); assert.equal(vault.data.accounts[0].level,null);
  assert.equal(vault.data.accounts[0].proxy,undefined);
  assert.ok(!fs.readFileSync(path.join(dir,'accounts.vault'),'utf8').includes(session.password));
  assert.equal(new LocalVault(dir).data.accounts[0].password,session.password);
});

function worker() {
  let listener, auth, completions = 0;
  const state = {localToken: 'token', active: {session: {id:'one',username:'fixture',password:'secret',proxy:{password:'proxy-secret'}},tabId:7,windowId:3}};
  const chrome = {runtime:{id:'ext',onMessage:{addListener:f=>listener=f}},action:{onClicked:{addListener(){}}},
    windows:{remove:async()=>{},onRemoved:{addListener(){}}},proxy:{settings:{clear:async()=>{}}},
    storage:{session:{get:async()=>structuredClone(state),set:async value=>Object.assign(state,value),remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete state[key];}}},
    webRequest:{onAuthRequired:{addListener:f=>auth=f},onCompleted:{addListener(){}},onErrorOccurred:{addListener(){}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/valorant-signup/background.js'),'utf8'),{chrome,Set,Map,URL,AbortSignal,
    fetch:async url=>{if(url.endsWith('/complete'))completions++;return {ok:true,json:async()=>({ok:true})};}});
  const sender = {id:'ext',frameId:0,tab:{id:7},url:'https://authenticate.riotgames.com/'};
  return {state, sender, completed:()=>completions, auth:(details)=>new Promise(r=>auth(details,r)), call:(message, from=sender)=>new Promise(r=>listener(message,from,r))};
}
test('extension restricts identity to assigned Riot tab, strips proxy and requires matching signup before success', async () => {
  const w = worker();
  for (const from of [{...w.sender,tab:{id:8}}, {...w.sender,url:'https://attacker.test/'}, {...w.sender,frameId:1}]) assert.equal((await w.call({type:'identity'},from)).ok,false);
  const identity = (await w.call({type:'identity'})).identity;
  assert.equal(identity.password,'secret'); assert.equal(identity.proxy,undefined);
  await w.call({type:'riot-result',receipt:{requestType:'verification',type:'success'}}); assert.equal(w.completed(),0);
  await w.call({type:'riot-result',receipt:{requestType:'signup',type:'success',username:'wrong'}}); assert.equal(w.completed(),0);
  await w.call({type:'riot-result',receipt:{requestType:'signup',type:'verification',username:'fixture'}}); assert.equal(w.completed(),0);
  await w.call({type:'riot-result',receipt:{requestType:'verification',type:'success'}}); assert.equal(w.completed(),1);
});
test('proxy credentials are sent only to the assigned proxy challenge and tab', async () => {
  const w = worker(); w.state.active.proxy = {host:'rp.scrapegw.com',port:8080,username:'proxy',password:'proxy-secret'};
  const details = {requestId:'one',tabId:7,isProxy:true,challenger:{host:'rp.scrapegw.com',port:8080}};
  for (const d of [{...details,isProxy:false}, {...details,tabId:8}, {...details,challenger:{host:'other.test',port:8080}}]) assert.equal((await w.auth(d)).authCredentials,undefined);
  assert.equal((await w.auth(details)).authCredentials.password,'proxy-secret');
});
test('normal form progression fills assigned email and optional choices stay off; repeat ticks cannot double submit', () => {
  const {create} = require('../extension/valorant-signup/flow.js'); let time = 0, clicks = 0;
  const input = {tagName:'INPUT',value:'',dispatchEvent(){}};
  const button = {dataset:{testid:'btn-signup-submit'},disabled:false,getAttribute(){return null;},click(){clicks++;}};
  const optional = {checked:true,click(){this.checked=false;}};
  const document = {querySelectorAll: selector => {
    if(selector === 'input[name="email_address"]')return [input];
    if(selector.includes('[data-testid="btn-signup-submit"]'))return [button];
    if(selector.startsWith('input#newsletter'))return [optional]; return [];
  }};
  const flow = create({document,now:()=>time,visible:()=>true});
  flow.step({email:'fixture@outlook.com'}); assert.equal(input.value,'fixture@outlook.com'); assert.equal(optional.checked,false); assert.equal(clicks,0);
  time = 1300; flow.step({email:'fixture@outlook.com'}); flow.step({email:'fixture@outlook.com'}); assert.equal(clicks,1);
});
test('network observer ignores generic login and sends only minimized signup receipts synchronously', async () => {
  const receipts = [], body = {type:'signup',username:'fixture',password:'secret'};
  class XHR {open(){} send(){}}
  let requestedBody;
  const window = {fetch:async(_url,opts)=>{requestedBody=opts.body;return {clone:()=>({json:async()=>({type:'success',token:'private-token'})})};},
    dispatchEvent:event=>receipts.push(JSON.parse(event.detail))};
  class CustomEvent {constructor(_name,value){Object.assign(this,value);}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/valorant-signup/observe.js'),'utf8'),{window,location:{href:'https://authenticate.riotgames.com/',origin:'https://authenticate.riotgames.com'},XMLHttpRequest:XHR,URL,CustomEvent});
  await window.fetch('/api/v1/login',{body:JSON.stringify({type:'auth',username:'fixture'})}); assert.equal(receipts.length,0);
  await window.fetch('/api/v1/login',{body:JSON.stringify(body)});
  assert.equal(requestedBody,JSON.stringify(body));
  assert.deepEqual(receipts,[{requestType:'signup',username:'fixture',type:'success',errorCode:null}]);
  assert.ok(!JSON.stringify(receipts).includes('secret')); assert.ok(!JSON.stringify(receipts).includes('private-token'));
});

test('six-box Riot email verification waits for mail then fills and submits the OTP control once', () => {
  const {create} = require('../extension/valorant-signup/flow.js'); let time = 0, clicks = 0;
  const fields = Array.from({length:6},()=>({tagName:'INPUT',value:'',dispatchEvent(){}}));
  const otp = {tagName:'DIV',querySelectorAll:()=>fields};
  const button = {dataset:{testid:'btn-otp-submit'},disabled:false,getAttribute(){return null;},click(){clicks++;}};
  const document = {querySelectorAll:selector=>selector.includes('[data-testid="otp-input"]')?[otp]:selector.includes('[data-testid="btn-otp-submit"]')?[button]:[]};
  const flow = create({document,now:()=>time,visible:()=>true});
  assert.equal(flow.step({}).stage,'verification');assert.equal(clicks,0);
  flow.step({},'123456');assert.equal(fields.map(f=>f.value).join(''),'123456');assert.equal(clicks,0);
  time = 1400;flow.step({},'123456');flow.step({},'123456');assert.equal(clicks,1);
});

test('proxy observation reads response pre even when another signup extension prepends a banner', async () => {
  let observation;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/valorant-signup/proxy-check.js'),'utf8'),{
    document:{querySelector:()=>({textContent:JSON.stringify({success:true,ip:'203.0.113.2',country_code:'JP'})}),
      body:{innerText:'Steam Signup: unassigned',prepend(){throw Error('unexpected failure');}}},
    chrome:{runtime:{sendMessage:async message=>{observation=message;return {ok:true};}}},
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(observation.type,'proxy-observed'); assert.equal(observation.location.country,'JP');
});
