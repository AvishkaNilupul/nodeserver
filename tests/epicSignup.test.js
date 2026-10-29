const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { findEpicOtp } = require('../utils/epicMailOtp');
const mailbox = require('../utils/epicMailbox');
const since = new Date(Date.now() - 60000).toISOString();
const otpReceivedAt = new Date(Date.now() + 60000).toISOString();
const message = (over = {}) => ({ from: { emailAddress: { address: 'help@acct.epicgames.com' } },
  receivedDateTime: new Date().toISOString(), subject: 'Your security code: 123456', ...over });

test('Epic codes must have the right sender and a fresh real timestamp', () => {
  for (const invalid of [
    message({ from: { emailAddress: { address: 'support@sooplive.com' } } }),
    message({ from: { emailAddress: { address: 'support@epicgames.com.evil.test' } } }),
    message({ receivedDateTime: '2020-01-01' }), message({ receivedDateTime: null }),
    message({ receivedDateTime: 'invalid' }),
  ]) assert.equal(findEpicOtp([invalid], since), null);
  assert.equal(findEpicOtp([message()], 'invalid'), null);
  assert.equal(findEpicOtp([message()], since).code, '123456');
  assert.equal(findEpicOtp([message({ subject: 'Verify', body: '<b>654321</b>' })], since).code, '654321');
  assert.equal(findEpicOtp([message({ receivedDateTime: since }), message({ subject: 'New code: 654321' })], since).code, '654321');
});
test('server accepts only recent local Outlook reservations', () => {
  const good = { address: 'stock@outlook.com', provider: 'outlook-local', reservedAt: since };
  assert.equal(mailbox.allocate(good).address, good.address);
  for (const bad of [{}, { ...good, provider: 'mailtm' }, { ...good, address: 'stock@outlook.com.evil.test' }, { ...good, reservedAt: '2000-01-01' }]) {
    assert.throws(() => mailbox.allocate(bad));
  }
});

function worker({ incognitoAllowed = true, existingPrivate = false } = {}) {
  const storage = {}; const calls = []; let listener; let auth; let removed; let nextTab = 10;
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => incognitoAllowed },
    windows: { getAll: async () => existingPrivate ? [{id: 99, incognito: true}] : [], create: async data => {calls.push(['window',data]);return { id: 100, tabs: [{ id: nextTab++ }] };},
      remove: async id => calls.push(['close-window', id]), onRemoved: { addListener: fn => removed = fn } },
    proxy: { settings: { get: async () => ({ levelOfControl: 'controllable_by_this_extension' }), set: async data => calls.push(['proxy', data]) } },
    webRequest: { onAuthRequired: { addListener: fn => auth = fn }, onCompleted: { addListener: () => {} }, onErrorOccurred: { addListener: () => {} } },
    storage: { session: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, storage[k]])),
      set: async data => Object.assign(storage, structuredClone(data)),
      remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(k => delete storage[k]),
    } },
    tabs: { create: async data => { calls.push(['tab', data]); return { id: nextTab++ }; }, update: async (id, data) => calls.push(['update', id, data]), sendMessage: async () => {} },
    runtime: { onMessage: { addListener: fn => listener = fn } },
  };
  const fetch = async (url, init) => {
    calls.push([url, JSON.parse(init.body || '{}')]);
    let body = { success: true };
    if (url.includes('/epic/proxy')) body = { ok: true, proxy: { scheme: 'http', host: 'proxy.test', port: 1234, username: 'user', password: 'proxy-secret' } };
    if (url.endsWith('/api/accounts')) body = [{ email: 'stock@outlook.com', uses: { epic: { status: 'fail' } } }];
    if (url.includes('/pool/pick')) body = { ok: true, email: 'stock@outlook.com' };
    if (url.includes('/otp?')) body = { ok: true, code: '123456', receivedAt: otpReceivedAt };
    if (url.includes('/from-extension')) body = { success: true, account: { _id: 'account' } };
    return { ok: true, json: async () => body };
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epicnpc-filler/background.js'), 'utf8'), { chrome, fetch, URL, AbortSignal, setTimeout });
  const send = (msg, id = 1, url = 'https://panel.test/epic-accounts.html') => new Promise(resolve => listener(msg, { tab: { id, url } }, resolve));
  return { storage, calls, send, auth: d => new Promise(resolve => auth(d, resolve)), removed: id => removed(id) };
}
test('extension reserves Outlook once, binds tabs, polls locally, and saves without leaking mail secrets', async () => {
  const w = worker();
  assert.equal((await w.send({ type: 'epicgen-ping' })).ok, true);
  assert.equal((await w.send({ type: 'epicgen-allocate' }, 2, 'https://unrelated.test/')).ok, false);
  const picked = await w.send({ type: 'epicgen-allocate' });
  assert.equal(picked.mailbox.address, 'stock@outlook.com');
  assert.equal((await w.send({ type: 'epicgen-allocate' })).ok, false);
  const s = { type: 'epicgen-drive', sessionId: 'session', bearer: 'secret', identity: { email: 'stock@outlook.com', password: 'pw' }, automation: { autoSubmit: true, autoAcceptEula: true }, redirectUrl: 'https://www.epicgames.com/id/api/redirect?clientId=abc' };
  assert.equal((await w.send(s)).ok, true);
  const epic = (type, extra = {}, id = 10) => w.send({ type, sessionId: 'session', ...extra }, id, 'https://www.epicgames.com/id/register');
  assert.equal((await epic('epicgen-session-request', {}, 99)).ok, false);
  const session = await epic('epicgen-session-request');
  assert.equal(session.session.identity.email, 'stock@outlook.com');
  assert.equal(session.session.bearer, undefined);
  assert.equal(session.session.automation.autoSubmit, true);
  assert.equal(session.session.automation.autoAcceptEula, true);
  assert.equal((await epic('epicgen-open-redirect')).ok, false);
  assert.equal((await epic('epicgen-request-otp')).code, '123456');
  await epic('epicgen-request-otp');
  assert.ok(w.calls.some(c => String(c[0]).includes(encodeURIComponent(new Date(Date.parse(otpReceivedAt)+1).toISOString()))));
  assert.ok(w.calls.some(c => String(c[0]).includes('127.0.0.1:3999') && String(c[0]).includes('for=epic&since=')));
  assert.equal((await epic('epicgen-open-redirect')).ok, true);
  assert.equal((await epic('epicgen-authcode', { code: 'a'.repeat(32) }, 11)).ok, true);
  assert.equal(w.storage['epicgen.active'], undefined);
  assert.ok(w.calls.some(c => String(c[0]).includes('/pool/release') && c[1].status === 'ok'));
});
test('cancel preserves a consumed reservation and permits another signup', async () => {
  const w = worker(); await w.send({ type: 'epicgen-allocate' });
  assert.equal((await w.send({ type: 'epicgen-cancel' }, 2)).ok, false);
  assert.equal((await w.send({ type: 'epicgen-cancel' })).ok, true);
  assert.ok(w.calls.some(c => String(c[0]).includes('/pool/release') && c[1].status === 'fail'));
  assert.equal((await w.send({ type: 'epicgen-allocate' })).ok, true);
});

test('proxy permission fails before consuming an inbox', async () => {
  const w = worker({ incognitoAllowed: false });
  assert.equal((await w.send({ type: 'epicgen-allocate', useProxy: true })).ok, false);
  assert.equal(w.calls.length, 0);
});
test('proxy is confined to the private session, authenticates assigned tabs, and cleans up', async () => {
  const w = worker();
  const picked = await w.send({ type: 'epicgen-allocate', useProxy: true });
  assert.equal(picked.proxy, undefined);
  assert.equal(JSON.stringify(picked).includes('proxy-secret'), false);
  await w.send({ type: 'epicgen-drive', sessionId: 'session', bearer: 'bearer', identity: { email: 'stock@outlook.com' }, redirectUrl: 'https://www.epicgames.com/id/api/redirect' });
  const settings = w.calls.find(c => c[0] === 'proxy')[1];
  assert.equal(settings.scope, 'incognito_session_only');
  assert.equal(settings.value.rules.singleProxy.host, 'proxy.test');
  const request = { isProxy: true, tabId: 10, challenger: { host: 'proxy.test', port: 1234 }, requestId: 'req' };
  assert.equal((await w.auth(request)).authCredentials.password, 'proxy-secret');
  assert.equal((await w.auth({ ...request, tabId: 99 })).authCredentials, undefined);
  assert.equal((await w.auth({ ...request, isProxy: false })).authCredentials, undefined);
  assert.equal((await w.auth({ ...request, challenger: { host: 'wrong.test', port: 1234 } })).authCredentials, undefined);
  await w.auth(request);
  assert.equal((await w.auth(request)).cancel, true);
  await w.send({ type: 'epicgen-cancel' });
  assert.ok(w.calls.some(c => c[0] === 'close-window' && c[1] === 100));
});

test('local proxy loader keeps one sticky username and validates configuration', () => {
  const { readProxy } = require('../utils/epicLocalProxy');
  const env = { RES_HOST: 'proxy.test', RES_PORT: '1234', RES_USER: 'user-sessid-old', RES_PASS: 'secret' };
  const p = readProxy(env, '/private/tmp/nonexistent-epic-proxy-test-config');
  assert.match(p.username, /^user-sessid-[a-f0-9]{16}$/);
  assert.equal(p.port, 1234);
  assert.throws(() => readProxy({}, '/private/tmp/nonexistent-epic-proxy-test-config'));
});

test('resuming a consumed Epic inbox does not allocate another address', async () => {
  const w = worker();
  const r = await w.send({ type: 'epicgen-allocate', resumeMailbox: { address: 'stock@outlook.com' } });
  assert.equal(r.ok, true);
  assert.equal(r.mailbox.address, 'stock@outlook.com');
  assert.equal(w.calls.some(c => String(c[0]).includes('/pool/pick')), false);
  assert.ok(w.calls.some(c => String(c[0]).includes('/pool/release') && c[1].status === 'reserved'));
});

function signupDom(document, location = { pathname: '/id/register', hash: '', hostname: 'www.epicgames.com' }, overrides = {}) {
  const source = fs.readFileSync(require.resolve('../extension/epicnpc-filler/epic-signup.js'), 'utf8');
  const start = source.lastIndexOf('  (async function () {');
  const messages = [];
  const context = { document, location, window: { getComputedStyle: () => ({ overflowY: 'auto' }) }, Event: class { constructor(type) {this.type=type;} }, console, setTimeout, ...overrides,
    chrome: { runtime: { sendMessage: (m, done) => { messages.push(m); done({ ok: true }); } } } };
  vm.runInNewContext(source.slice(0, start) + 'globalThis.dom = { stepId, scrapeAuthCode, clickContinueLike, waitForStepChange, clickAgreementAccept, clickReviewContinue, continueAfterChallenge };\n})();', context);
  return { ...context.dom, messages };
}
test('current Epic OTP boxes and successive login screens are recognized', () => {
  const document = { querySelectorAll: selector => selector.includes('code-input-') ? Array(6).fill({}) : [], querySelector: () => null, getElementById: () => null };
  assert.equal(signupDom(document).stepId(), 'otp');
  assert.equal(signupDom(document, { pathname: '/id/login/correction/eula', hash: '' }).stepId(), 'agreement');
  assert.equal(signupDom(document, { pathname: '/account/personal', hash: '', hostname: 'accounts.epicgames.com' }).stepId(), 'done');
  assert.equal(signupDom(document, { pathname: '/id/login/review/mfa-settings', hash: '' }).stepId(), 'login_review_mfa');
  assert.equal(signupDom(document, { pathname: '/id/login/review/link-console', hash: '' }).stepId(), 'login_review_console');
});
test('authorization capture reads JSON from pre without grabbing unrelated account IDs', async () => {
  const code = 'b'.repeat(32);
  const banner = { style: {}, dataset: {}, textContent: '' };
  const document = { body: { textContent: 'Pretty-print {"accountId":"' + 'a'.repeat(32) + '"}' },
    querySelector: () => ({ textContent: JSON.stringify({ accountId: 'a'.repeat(32), authorizationCode: code }) }),
    getElementById: () => banner };
  const driver = signupDom(document);
  await driver.scrapeAuthCode({});
  assert.equal(driver.messages.at(-1).code, code);
});

test('new-account EULA correction opens the official review flow without accepting it', async () => {
  const location = { pathname: '/id/api/redirect', hash: '', hostname: 'www.epicgames.com' };
  const banner = { style: {}, dataset: {}, textContent: '' };
  const document = { body: { textContent: '' },
    querySelector: () => ({ textContent: JSON.stringify({ errorCode: 'errors.com.epicgames.oauth.corrective_action_required', metadata: { correctiveAction: 'EULA_ACCEPTANCE' } }) }),
    getElementById: () => banner };
  const driver = signupDom(document, location);
  await driver.scrapeAuthCode({});
  assert.equal(location.href, 'https://store.epicgames.com/en-US/');
  assert.equal(driver.messages.at(-1).status, 'awaiting_eula');
  assert.equal(driver.messages.some(m => m.type === 'epicgen-authcode'), false);
});


test('Continue ignores hidden and disabled matching buttons', () => {
  let clicks = 0;
  const button = (extra = {}) => ({ textContent: 'Continue', offsetParent: {}, disabled: false,
    getAttribute: () => null, click: () => clicks++, ...extra });
  const hidden = button({ offsetParent: null });
  const disabled = button({ disabled: true });
  const ready = button();
  const document = { getElementById: () => disabled, querySelectorAll: () => [hidden, disabled, ready] };
  assert.equal(signupDom(document).clickContinueLike(), true);
  assert.equal(clicks, 1);
  document.querySelectorAll = () => [hidden, disabled];
  assert.equal(signupDom(document).clickContinueLike(), false);
  assert.equal(clicks, 1);
});

test('stalled navigation returns after its deadline', async () => {
  const document = { querySelectorAll: sel => sel.includes('iframe')?[]:Array(6).fill({}), querySelector: () => null, getElementById: () => null };
  const started = Date.now();
  assert.equal(await signupDom(document).waitForStepChange('otp', 1), 'otp');
  assert.ok(Date.now() - started < 1500);
});


test('agreement readiness scrolls its document and accepts only an enabled button', () => {
  let clicks=0,scrolls=0;
  const panel={scrollHeight:1000,clientHeight:200,scrollTop:0,dispatchEvent:e=>{if(e.type==='scroll')scrolls++;}};
  const accept={textContent:'Accept',offsetParent:{},disabled:true,getAttribute:()=>null,click:()=>clicks++};
  const doc={querySelectorAll:sel=>sel==='button'?[accept]:[panel]};
  const driver=signupDom(doc);
  assert.equal(driver.clickAgreementAccept(),false);
  assert.equal(panel.scrollTop,1000);assert.equal(scrolls,1);assert.equal(clicks,0);
  accept.disabled=false;assert.equal(driver.clickAgreementAccept(),true);assert.equal(clicks,1);
});


test('visible captcha pauses the navigation deadline and resumes when dismissed', async () => {
  let time=1000, checks=0;
  const frame={offsetParent:null,getBoundingClientRect:()=>({width:400,height:300})};
  const doc={querySelectorAll:sel=>sel.includes('iframe')?(++checks<4?[frame]:[]):sel.includes('code-input-')?Array(6).fill({}):[],querySelector:()=>null,getElementById:()=>null};
  const driver=signupDom(doc,undefined,{Date:{now:()=>time},setTimeout:fn=>{time+=400;fn();}});
  assert.equal(await driver.waitForStepChange('otp',1),'otp');
  assert.equal(checks,4);
  assert.equal(time,2600);
});


test('email MFA token error opens normal sign-in without submitting another registration', async () => {
  const location={pathname:'/id/api/redirect',hash:'',hostname:'www.epicgames.com'};
  const response={errorCode:'errors.com.epicgames.common.two_factor_authentication.required',metadata:{twoFactorMethod:'email'}};
  const doc={body:{textContent:''},querySelector:()=>({textContent:JSON.stringify(response)}),getElementById:()=>({style:{},dataset:{}})};
  const driver=signupDom(doc,location);await driver.scrapeAuthCode({});
  assert.equal(location.href,'https://accounts.epicgames.com/auth/logout');
  assert.equal(driver.messages.at(-1).type,'epicgen-recover-auth');
  assert.equal(driver.messages.some(m=>m.type==='epicgen-authcode'),false);
});

test('email authentication recovery is bound to a verified tab and attempted once', async () => {
  const w=worker();await w.send({type:'epicgen-allocate'});
  await w.send({type:'epicgen-drive',sessionId:'session',bearer:'secret',identity:{email:'stock@outlook.com'},redirectUrl:'https://www.epicgames.com/id/api/redirect'});
  const epic=type=>w.send({type,sessionId:'session'},10,'https://www.epicgames.com/id/api/redirect');
  assert.equal((await epic('epicgen-recover-auth')).ok,false);
  await epic('epicgen-request-otp');assert.equal((await epic('epicgen-recover-auth')).ok,true);
  assert.equal((await epic('epicgen-session-request')).session.login,true);
  assert.equal((await epic('epicgen-recover-auth')).ok,false);
});

test('an explicit rejected-code banner ends the OTP wait immediately for retry',async()=>{
 const doc={body:{textContent:'The security code is invalid or expired.'},querySelectorAll:sel=>sel.includes('code-input-')?Array(6).fill({}):[],querySelector:()=>null,getElementById:()=>null};
 assert.equal(await signupDom(doc).waitForStepChange('otp',180000),'otp_invalid');
});


test('console review recognizes the visible Done linking label',()=>{
 let clicked=0;
 const button={innerText:'Done linking',textContent:'Done linking',offsetParent:{},disabled:false,getAttribute:()=>null,click:()=>clicked++};
 const driver=signupDom({querySelectorAll:()=>[button]});
 assert.equal(driver.clickReviewContinue('login_review_console'),true);assert.equal(clicked,1);
 assert.equal(driver.clickReviewContinue('login_review_mfa'),false);
});

test('Epic challenge handoff rejection is distinguished from an invalid email code',async()=>{
 const doc={body:{textContent:'Incorrect response. Please refresh the page.'},querySelectorAll:sel=>sel.includes('code-input-')?Array(6).fill({}):[],querySelector:()=>null,getElementById:()=>null};
 assert.equal(await signupDom(doc).waitForStepChange('otp',180000),'challenge_rejected');
});
test('challenge refresh is bound to the signup tab and stops after two attempts',async()=>{
 const w=worker();await w.send({type:'epicgen-allocate'});
 await w.send({type:'epicgen-drive',sessionId:'session',bearer:'secret',identity:{email:'stock@outlook.com'},redirectUrl:'https://www.epicgames.com/id/api/redirect'});
 const retry=id=>w.send({type:'epicgen-retry-challenge',sessionId:'session'},id,'https://www.epicgames.com/id/login/mfa');
 assert.equal((await retry(99)).ok,false);assert.equal((await retry(10)).ok,true);assert.equal((await retry(10)).ok,true);assert.equal((await retry(10)).ok,false);
});


test('a cleared captcha resumes the same ready form once after settling',()=>{
 let time=1000,clicks=0;
 const button={textContent:'Continue',offsetParent:{},disabled:false,getAttribute:()=>null,click:()=>clicks++};
 const doc={body:{textContent:''},getElementById:()=>button,querySelectorAll:selector=>selector.includes('textarea')?[{value:'completed-response'}]:[]};
 const driver=signupDom(doc,undefined,{Date:{now:()=>time}}),state={seen:false,clearedAt:0,clicks:0};
 assert.equal(driver.continueAfterChallenge(state,true),false);
 assert.equal(driver.continueAfterChallenge(state,false),false);time+=1001;
 assert.equal(driver.continueAfterChallenge(state,false),false);assert.equal(clicks,0);time+=2000;
 assert.equal(driver.continueAfterChallenge(state,false),true);
 assert.equal(driver.continueAfterChallenge(state,false),false);assert.equal(clicks,1);
 doc.body.textContent='Incorrect response. Please refresh the page.';
 driver.continueAfterChallenge(state,true);time+=1001;assert.equal(driver.continueAfterChallenge(state,false),false);
});

test('closing a failed proxy window preserves its original diagnostic',async()=>{
 const w=worker();await w.send({type:'epicgen-allocate',useProxy:true});
 await w.send({type:'epicgen-drive',sessionId:'session',bearer:'secret',identity:{email:'stock@outlook.com'},redirectUrl:'https://www.epicgames.com/id/api/redirect'});
 await w.send({type:'epicgen-abort',sessionId:'session',reason:'CAPTCHA handoff rejected'},10,'https://www.epicgames.com/id/register');
 await w.removed(100);
 const statuses=w.calls.filter(c=>String(c[0]).endsWith('/status'));
 assert.equal(statuses.length,1);assert.equal(statuses[0][1].lastError,'CAPTCHA handoff rejected');
 assert.equal(w.storage['epicgen.active'],undefined);
});


test('MFA with a missing email context restarts login rather than retrying the code',async()=>{
 const doc={body:{textContent:'email is invalid'},querySelectorAll:sel=>sel.includes('code-input-')?Array(6).fill({}):[],querySelector:()=>null,getElementById:()=>null};
 const driver=signupDom(doc,{pathname:'/id/login/mfa',hash:'',hostname:'www.epicgames.com'});
 assert.equal(await driver.waitForStepChange('otp',180000),'auth_context_rejected');
});
test('login context reset is bounded independently from CAPTCHA refresh',async()=>{
 const w=worker();await w.send({type:'epicgen-allocate'});
 await w.send({type:'epicgen-drive',sessionId:'session',bearer:'secret',identity:{email:'stock@outlook.com'},redirectUrl:'https://www.epicgames.com/id/api/redirect'});
 const reset=id=>w.send({type:'epicgen-reset-auth-context',sessionId:'session'},id,'https://www.epicgames.com/id/login/mfa');
 assert.equal((await reset(99)).ok,false);assert.equal((await reset(10)).ok,true);assert.equal((await reset(10)).ok,false);
});

test('ProxyScrape uses documented session and lifetime fields while retaining country',()=>{
 const {readProxy}=require('../utils/epicLocalProxy');
 const p=readProxy({RES_HOST:'rp.scrapegw.com',RES_PORT:'6060',RES_USER:'user-country-jp-sessid-old-session-old-lifetime-5',RES_PASS:'secret'},'/private/tmp/no-epic-test-proxy-config');
 assert.match(p.username,/^user-country-jp-session-[a-f0-9]{16}-lifetime-30$/);
 assert.equal(p.username.includes('-sessid-'),false);
});


test('explicit retry reuses the assigned identity and cannot reset another tab',async()=>{
 const w=worker();await w.send({type:'epicgen-allocate'});
 await w.send({type:'epicgen-drive',sessionId:'session',bearer:'secret',identity:{email:'stock@outlook.com',password:'pw'},redirectUrl:'https://www.epicgames.com/id/api/redirect?clientId=abc'});
 w.storage['epicgen.active'].challengeReloads=2;
 const send=(id)=>w.send({type:'epicgen-resume-current',sessionId:'session'},id,'https://www.epicgames.com/id/register');
 assert.equal((await send(99)).ok,false);assert.equal(w.storage['epicgen.active'].challengeReloads,2);
 assert.equal((await send(10)).ok,true);assert.equal(w.storage['epicgen.active'].challengeReloads,0);
 assert.equal(w.storage['epicgen.active'].identity.email,'stock@outlook.com');
 assert.equal(w.calls.filter(c=>String(c[0]).includes('/pool/pick')).length,1);
});

test('normal-connection signups isolate cookies and keep capture in the same private window', async () => {
 const w=worker(); await w.send({type:'epicgen-allocate'});
 assert.equal((await w.send({type:'epicgen-drive',sessionId:'isolated',bearer:'bearer',identity:{email:'stock@outlook.com'},redirectUrl:'https://www.epicgames.com/id/api/redirect'})).ok,true);
 assert.equal(w.calls.find(c=>c[0]==='window')[1].incognito,true);
 assert.equal(w.calls.some(c=>c[0]==='proxy'),false);
 assert.equal(w.storage['epicgen.active'].windowId,100);
 await w.send({type:'epicgen-request-otp',sessionId:'isolated'},10,'https://www.epicgames.com/id/register');
 await w.send({type:'epicgen-open-redirect',sessionId:'isolated'},10,'https://www.epicgames.com/id/register');
 assert.equal(w.calls.find(c=>c[0]==='tab')[1].windowId,100);
 await w.send({type:'epicgen-authcode',sessionId:'isolated',code:'a'.repeat(32)},11,'https://www.epicgames.com/id/api/redirect');
 assert.ok(w.calls.some(c=>c[0]==='close-window'&&c[1]===100));
});
test('isolation prerequisites fail before consuming or resuming any inbox',async()=>{
 for(const options of [{incognitoAllowed:false},{existingPrivate:true}]) {
  const w=worker(options);assert.equal((await w.send({type:'epicgen-allocate'})).ok,false);
  assert.equal(w.calls.length,0);assert.equal(w.storage['epicgen.pending'],undefined);
 }
});
