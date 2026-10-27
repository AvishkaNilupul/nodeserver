const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { findEpicOtp } = require('../utils/epicMailOtp');
const mailbox = require('../utils/epicMailbox');
const since = new Date(Date.now() - 60000).toISOString();
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

function worker({ incognitoAllowed = true } = {}) {
  const storage = {}; const calls = []; let listener; let auth; let removed; let nextTab = 10;
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => incognitoAllowed },
    windows: { getAll: async () => [], create: async () => ({ id: 100, tabs: [{ id: nextTab++ }] }),
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
    if (url.includes('/otp?')) body = { ok: true, code: '123456' };
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
  const s = { type: 'epicgen-drive', sessionId: 'session', bearer: 'secret', identity: { email: 'stock@outlook.com', password: 'pw' }, redirectUrl: 'https://www.epicgames.com/id/api/redirect?clientId=abc' };
  assert.equal((await w.send(s)).ok, true);
  const epic = (type, extra = {}, id = 10) => w.send({ type, sessionId: 'session', ...extra }, id, 'https://www.epicgames.com/id/register');
  assert.equal((await epic('epicgen-session-request', {}, 99)).ok, false);
  const session = await epic('epicgen-session-request');
  assert.equal(session.session.identity.email, 'stock@outlook.com');
  assert.equal(session.session.bearer, undefined);
  assert.equal((await epic('epicgen-open-redirect')).ok, false);
  assert.equal((await epic('epicgen-request-otp')).code, '123456');
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

function signupDom(document, location = { pathname: '/id/register', hash: '', hostname: 'www.epicgames.com' }) {
  const source = fs.readFileSync(require.resolve('../extension/epicnpc-filler/epic-signup.js'), 'utf8');
  const start = source.lastIndexOf('  (async function () {');
  const messages = [];
  const context = { document, location, window: {}, console, setTimeout,
    chrome: { runtime: { sendMessage: (m, done) => { messages.push(m); done({ ok: true }); } } } };
  vm.runInNewContext(source.slice(0, start) + 'globalThis.dom = { stepId, scrapeAuthCode };\n})();', context);
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
  const banner = { style: {}, textContent: '' };
  const document = { body: { textContent: 'Pretty-print {"accountId":"' + 'a'.repeat(32) + '"}' },
    querySelector: () => ({ textContent: JSON.stringify({ accountId: 'a'.repeat(32), authorizationCode: code }) }),
    getElementById: () => banner };
  const driver = signupDom(document);
  await driver.scrapeAuthCode({});
  assert.equal(driver.messages.at(-1).code, code);
});

test('new-account EULA correction opens the official review flow without accepting it', async () => {
  const location = { pathname: '/id/api/redirect', hash: '', hostname: 'www.epicgames.com' };
  const banner = { style: {}, textContent: '' };
  const document = { body: { textContent: '' },
    querySelector: () => ({ textContent: JSON.stringify({ errorCode: 'errors.com.epicgames.oauth.corrective_action_required', metadata: { correctiveAction: 'EULA_ACCEPTANCE' } }) }),
    getElementById: () => banner };
  const driver = signupDom(document, location);
  await driver.scrapeAuthCode({});
  assert.equal(location.href, 'https://store.epicgames.com/en-US/');
  assert.equal(driver.messages.at(-1).status, 'awaiting_eula');
  assert.equal(driver.messages.some(m => m.type === 'epicgen-authcode'), false);
});
