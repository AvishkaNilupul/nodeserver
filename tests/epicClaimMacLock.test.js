// Claims through the Mac (2026-11-01): a locked screen or a helper that has
// stopped checking in is refused at once with the reason, the bridge's limit
// leaves room for the helper's own answer, and the scheduler stops a run on
// the first refusal, sends one message, and asks the Mac again in 15 min.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const {createBridge, screenLockedIn} = require('../tools/epic-claim-worker/extension-worker.cjs');
const region = require('../utils/epicRegion');

// --- Mac bridge -------------------------------------------------------------
function fakeExpress() { const routes = {}; return {routes, disable() {}, use() {}, get(p, ...h) { routes['GET ' + p] = h; }, post(p, ...h) { routes['POST ' + p] = h; }}; }
fakeExpress.json = () => () => {};
function res() { return {code: 200, status(v) { this.code = v; return this; }, json(v) { this.body = v; return this; }, sendStatus(v) { this.code = v; return this; }}; }
function call(app, key, auth, body) {
  const r = res(), req = {get: k => k === 'authorization' ? 'Bearer ' + auth : '127.0.0.1:8123', body};
  const handlers = app.routes[key]; let i = 0; const next = () => handlers[i++]?.(req, r, next); next(); return r;
}
function clock(start = 1e6) {
  let t = start, seq = 0; const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({id, at: t + ms, fn}); return id; },
    clearTimer: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) { timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = n.at; n.fn(); }
      t = end;
    },
  };
}
const token = 'server-secret';
const job = {exchangeCode: 'a'.repeat(32), namespace: 'b'.repeat(32), offerId: 'c'.repeat(32), accountKey: 'd'.repeat(32), displayName: 'test'};
function bridge(opts = {}) {
  const c = clock(), logs = [];
  const b = createBridge({express: fakeExpress, token, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, log: l => logs.push(l), ...opts});
  call(b.app, 'GET /extension/status', b.extensionToken);
  return {...b, c, logs};
}

test('a locked Mac screen refuses a claim at once with the reason, and health says why', () => {
  let locked = true; const b = bridge({screenLocked: () => locked});
  const r = call(b.app, 'POST /claim', token, job);
  assert.equal(r.code, 503); assert.equal(r.body.status, 'worker_unavailable');
  assert.equal(r.body.error, 'Mac screen is locked; unlock it so Chrome can run claims');
  assert.equal(call(b.app, 'GET /extension/next', b.extensionToken).body.job, null);
  const h = call(b.app, 'GET /health', token).body;
  assert.equal(h.ready, false); assert.equal(h.screenLocked, true); assert.match(h.reason, /screen is locked/);
  locked = false;
  assert.equal(call(b.app, 'GET /health', token).body.ready, true);
  assert.match(b.logs.join('\n'), /claim for test offer cccccccc refused: Mac screen is locked/);
});

test('a helper that stopped checking in is refused with how long ago it last did', () => {
  const b = bridge(); b.c.advance(125000);
  const r = call(b.app, 'POST /claim', token, job);
  assert.equal(r.code, 503); assert.match(r.body.error, /has not checked in for 125 s/);
  assert.equal(call(b.app, 'GET /health', token).body.lastSeenSecondsAgo, 125);
});

test('a job the helper never picks up is withdrawn as unavailable after 60 s', () => {
  const b = bridge();
  const r = call(b.app, 'POST /claim', token, job);
  b.c.advance(59000); assert.equal(r.body, undefined);
  b.c.advance(1000);
  assert.equal(r.body.status, 'worker_unavailable'); assert.match(r.body.error, /did not pick up the job within 60 s/);
  assert.equal(call(b.app, 'GET /extension/next', b.extensionToken).body.job, null);
});

test('the checkout limit counts from pickup, so the helper\'s own answer gets through', () => {
  const b = bridge();
  const r = call(b.app, 'POST /claim', token, job);
  b.c.advance(30000); const assigned = call(b.app, 'GET /extension/next', b.extensionToken).body.job;
  // 30 s to pick up + the helper's 120 s: the old bridge gave up at 150 s, so
  // every stalled claim read "Browser checkout timed out" (19 of 19 on prod).
  b.c.advance(125000); assert.equal(r.body, undefined);
  const answer = 'Checkout did not finish (store.epicgames.com/purchase#/free-checkout, page hidden by Chrome)';
  assert.equal(call(b.app, 'POST /extension/result', b.extensionToken, {id: assigned.id, lease: assigned.lease, status: 'error', error: answer}).code, 200);
  assert.deepEqual({...r.body}, {status: 'error', error: answer});
});

test('a checkout with no answer ends 180 s after pickup, and a late answer is still logged', () => {
  const b = bridge();
  const r = call(b.app, 'POST /claim', token, job); b.c.advance(10000);
  const assigned = call(b.app, 'GET /extension/next', b.extensionToken).body.job;
  b.c.advance(179000); assert.equal(r.body, undefined);
  b.c.advance(1000); assert.equal(r.body.status, 'error'); assert.equal(r.body.error, 'Browser checkout timed out; verify library');
  const late = {id: assigned.id, lease: assigned.lease, status: 'error', error: 'Checkout did not finish (www.epicgames.com/id/exchange)'};
  assert.equal(call(b.app, 'POST /extension/result', b.extensionToken, late).code, 409);
  const log = b.logs.join('\n');
  assert.match(log, /test offer cccccccc queued/);
  assert.match(log, /picked up after 10 s/);
  assert.match(log, /timed out after 190 s: error - Browser checkout timed out/);
  assert.match(log, /test offer cccccccc late result ignored: error - Checkout did not finish \(www\.epicgames\.com\/id\/exchange\)/);
  assert.equal(log.includes(job.exchangeCode) || log.includes(assigned.lease) || log.includes(token), false);
});

test('account recovery keeps its single 240 s budget and never logs the login', () => {
  const b = bridge();
  const r = call(b.app, 'POST /recover', token, {accountKey: 'd'.repeat(32), displayName: 'test', email: 'test@example.com', password: 'test-fixture'});
  b.c.advance(100000); assert.equal(call(b.app, 'GET /extension/next', b.extensionToken).body.job.mode, 'recover');
  b.c.advance(139000); assert.equal(r.body, undefined);
  b.c.advance(1000); assert.deepEqual({...r.body}, {status: 'error', error: 'Account sign-in timed out'});
  assert.equal(/test-fixture|test@example\.com/.test(b.logs.join('\n')), false);
});

test('the lock flag is read from the macOS console session', () => {
  const session = extra => '<dict><key>kCGSSessionOnConsoleKey</key>\n\t\t\t<true/>' + extra + '<key>kCGSSessionUserNameKey</key><string>owner</string></dict>';
  assert.equal(screenLockedIn(session('<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>')), true);
  assert.equal(screenLockedIn(session('')), false);
  assert.equal(screenLockedIn(''), false);
});

// --- Chrome helper ------------------------------------------------------------
const checkoutSource = fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-checkout.js'), 'utf8');
async function stalledCheckout({location, deadline, hidden = false}) {
  let delay, fire; const reports = [];
  await vm.runInNewContext(checkoutSource, {window: {addEventListener() {}}, Date, location, URLSearchParams,
    document: {hidden, body: {innerText: 'Loading'}, querySelectorAll: () => []}, getComputedStyle: () => ({visibility: 'visible'}),
    setInterval: () => 1, clearInterval() {}, setTimeout: (f, ms) => { fire = f; delay = ms; },
    chrome: {runtime: {sendMessage: async m => m.type === 'epicclaim-context'
      ? {ok: true, job: {namespace: 'game', offerId: 'offer', displayName: 'right-account'}, ...(deadline ? {deadline} : {})}
      : (reports.push(m), {ok: true})}}});
  await fire();
  return {delay, report: reports[0]};
}

test('the checkout page gives up on the job deadline and says where it stopped', async () => {
  const purchase = {hostname: 'store.epicgames.com', pathname: '/purchase', search: '?offers=1-game-offer', hash: '#/free-checkout'};
  const r = await stalledCheckout({location: purchase, deadline: Date.now() + 30000, hidden: true});
  assert.ok(r.delay > 29000 && r.delay <= 30000, 'delay ' + r.delay);
  assert.equal(r.report.status, 'error');
  assert.equal(r.report.error, 'Checkout did not finish (store.epicgames.com/purchase#/free-checkout, page hidden by Chrome)');
  // Stuck on the exchange page: the place never includes its login code.
  const exchange = {hostname: 'www.epicgames.com', pathname: '/id/exchange', search: '?exchangeCode=' + 'f'.repeat(32), hash: ''};
  const e = await stalledCheckout({location: exchange, deadline: Date.now() + 30000});
  assert.equal(e.report.error, 'Checkout did not finish (www.epicgames.com/id/exchange)');
  // A background page from before this change sends no deadline.
  assert.equal((await stalledCheckout({location: purchase})).delay, 110000);
});

function helperBackground({active, fetchAnswer = {ok: true, json: async () => ({ok: true})}, tab = null}) {
  const bodies = [], removed = []; let listener;
  const session = {[`epicclaim.job`]: active};
  const chrome = {
    storage: {
      local: {get: async () => ({'epicclaim.connection': {origin: 'http://127.0.0.1:8123', token: 'dummy', isolateSessions: true}})},
      session: {get: async keys => Object.fromEntries([].concat(keys).filter(k => session[k]).map(k => [k, session[k]])), set: async () => {}, remove: async k => { removed.push(k); delete session[k]; }},
    },
    alarms: {create() {}, onAlarm: {addListener() {}}},
    runtime: {onMessage: {addListener: f => listener = f}},
    browsingData: {removeCookies: async () => {}},
    tabs: {onUpdated: {addListener() {}}, get: async () => tab, remove: async () => {}, create: async () => ({id: 1}), update: async () => {}},
  };
  const fetch = async (url, init) => { if (init && init.body) bodies.push({url, body: JSON.parse(init.body)}); return fetchAnswer; };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/epic-claim-helper/epic-claim-background.js'), 'utf8'), {chrome, fetch, AbortSignal, URL, Date, console, setTimeout});
  const send = (msg, sender) => new Promise(resolve => listener(msg, sender, resolve));
  return {bodies, removed, send};
}
const claimJob = {id: 'job-1', lease: 'lease-1', exchangeCode: 'f'.repeat(32), namespace: 'ns', offerId: 'offer', displayName: 'acct'};
const claimTab = {id: 7, url: 'https://store.epicgames.com/purchase?offers=1-ns-offer'};

test('the helper hands its checkout page a deadline 120 s after the job started', async () => {
  const h = helperBackground({active: {job: claimJob, tabId: 7, startedAt: Date.now()}});
  const r = await h.send({type: 'epicclaim-context'}, {tab: claimTab});
  assert.equal(r.ok, true); assert.equal(r.deadline - Date.now() <= 120000 && r.deadline - Date.now() > 119000, true);
});

test('a claim tab that made no progress is reported with where it was, without the login code', async () => {
  const h = helperBackground({active: {job: claimJob, tabId: 7, startedAt: Date.now() - 131000},
    tab: {id: 7, url: 'https://www.epicgames.com/id/exchange?exchangeCode=' + 'f'.repeat(32), status: 'loading'}});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.bodies.length, 1);
  assert.deepEqual({...h.bodies[0].body}, {id: 'job-1', lease: 'lease-1', status: 'error', error: 'Assigned claim tab made no progress (www.epicgames.com/id/exchange, still loading)'});
  assert.equal(JSON.stringify(h.bodies).includes('f'.repeat(32)), false);
  assert.deepEqual([...h.removed], ['epicclaim.job']);
});

test('an answer the bridge no longer wants still frees the helper for the next job', async () => {
  const h = helperBackground({active: {job: claimJob, tabId: 7, startedAt: Date.now()}, fetchAnswer: {ok: false, status: 409}});
  const r = await h.send({type: 'epicclaim-result', status: 'error', error: 'Checkout did not finish'}, {tab: claimTab});
  assert.equal(r.ok, false);
  assert.deepEqual([...h.removed], ['epicclaim.job']);
});

// --- Server: one claim attempt ------------------------------------------------
const offer = {offerId: 'closed', namespace: 'ns-closed', title: "Sorry We're Closed", active: true};
const acct = id => ({_id: id, accountId: id.padEnd(32, '0'), displayName: id, status: 'ok', library: [], autoClaimLog: [], save: async () => {}});
function autoClaim({post = async () => { throw Error('no claim expected'); }, get = async () => { throw Error('no health check expected'); }} = {}) {
  let verifies = 0, reads = 0; const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicAutoClaim'), 'utf8'), {module, exports: module.exports, Date, Buffer, Set, Map,
    process: {env: {EPIC_CLAIM_WORKER_URL: 'http://worker', EPIC_CLAIM_WORKER_TOKEN: 'fixture'}}, require: n => {
      if (n === './epicClaimBackoff') return {until: () => 0, block: () => Date.now() + 60000, settle() {}};
      if (n === 'axios') return {post, get};
      if (n === './epicOfferWindow') return require('../utils/epicOfferWindow');
      if (n === './epicRegion') return region;
      if (n === './epicClient') return {exchangeCode: async () => 'code', getLibraryRecords: async () => { reads++; return []; }};
      if (n === './epicClaimResult') return {verifyClaimResult: async r => { verifies++; return r; }};
      if (n === './epicAccountToken') return {accountAccessToken: async () => 'access'};
      if (n === './settings') return {getEpicAutoClaim: () => ({enabled: true, dailyCap: 20, perAccountCooldownH: 0})};
      if (n === './captchaSolver') return {detectProvider: () => ''};
      if (n === './secretBox') return {decrypt: v => v}; throw Error(n);
    }});
  return {api: module.exports, verifies: () => verifies, reads: () => reads};
}

test('a Mac refusal keeps the bridge\'s reason, uses no try, and skips the library re-check', async () => {
  const locked = 'Mac screen is locked; unlock it so Chrome can run claims';
  for (const answer of [{status: 503, data: {status: 'worker_unavailable', error: locked}},
    {status: 200, data: {status: 'worker_unavailable', error: 'Chrome claim helper did not pick up the job within 60 s'}}]) {
    const s = autoClaim({post: async () => answer}), a = acct('a');
    const r = await s.api.attemptAutoClaim(a, offer, 'access');
    assert.equal(r.status, 'worker_unavailable'); assert.equal(r.attempted, false); assert.equal(r.error, answer.data.error);
    assert.equal(s.verifies(), 0); assert.equal(s.reads(), 1);
    assert.equal(a.autoClaimLog.length, 0); assert.equal(s.api.getStatus().todayCount, 0); assert.equal(s.api.getStatus().nextCheckoutAt, null);
  }
  // A checkout that did run is still checked against the library.
  const ran = autoClaim({post: async () => ({status: 200, data: {status: 'error', error: 'Checkout did not finish'}})});
  await ran.api.attemptAutoClaim(acct('b'), offer, 'access'); assert.equal(ran.verifies(), 1);
});

test('the readiness check asks the bridge\'s health and never touches Epic', async () => {
  const answers = [
    {status: 200, data: {ok: true, connected: true, busy: false, screenLocked: false, ready: true}},
    {status: 200, data: {ok: true, connected: true, busy: false, screenLocked: true, ready: false, reason: 'Mac screen is locked; unlock it so Chrome can run claims'}},
    {status: 200, data: {ok: true, mode: 'extension', connected: true, busy: false}},
    {status: 200, data: {ok: true, mode: 'extension', connected: false, busy: false}},
    {status: 401, data: ''},
  ];
  const gets = []; const s = autoClaim({get: async (url, opts) => { gets.push({url, auth: opts.headers.Authorization}); return answers.shift(); }});
  assert.deepEqual({...await s.api.workerReady()}, {ready: true});
  assert.deepEqual({...await s.api.workerReady()}, {ready: false, reason: 'Mac screen is locked; unlock it so Chrome can run claims'});
  assert.deepEqual({...await s.api.workerReady()}, {ready: true});
  assert.deepEqual({...await s.api.workerReady()}, {ready: false, reason: 'Chrome claim helper is not checking in'});
  assert.match((await s.api.workerReady()).reason, /HTTP 401/);
  assert.deepEqual({...gets[0]}, {url: 'http://worker/health', auth: 'Bearer fixture'}); assert.equal(s.reads(), 0);
  const down = autoClaim({get: async () => { throw Object.assign(Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'}); }});
  assert.deepEqual({...await down.api.workerReady()}, {ready: false, reason: 'Mac claim bridge unreachable (ECONNREFUSED)'});
});

// --- Server: the scheduled run ------------------------------------------------
function claimer({accounts, results = [], ready = []}) {
  const attempts = [], pings = [], probes = []; const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicClaimer'), 'utf8'), {module, exports: module.exports, Date, Map, Set, Math, console, process: {env: {}}, setTimeout, require: n => {
    if (n === '../models/EpicAccount') return {find: async () => accounts};
    if (n === '../models/EpicFreebie') return {find: () => ({lean: async () => [offer]})};
    if (n === './epicClient') return {getLibraryRecords: async () => []};
    if (n === './epicAutoClaim') return {
      attemptAutoClaim: async acc => { attempts.push(acc.displayName); return results.shift() || {attempted: true, status: 'claimed'}; },
      workerReady: async () => { probes.push(1); return ready.shift() || {ready: true}; },
    };
    if (n === './epicAccountToken') return {accountAccessToken: async () => 'access'};
    if (n === './telegram') return {sendTelegram: async text => pings.push(text)};
    if (n === './epicClaimBackoff') return {until: () => 0};
    if (n === './epicRegion') return region;
    if (n === './epicOfferWindow') return require('../utils/epicOfferWindow');
    throw Error(n);
  }});
  return {api: module.exports, attempts, pings, probes, results};
}
const LOCKED = {attempted: false, status: 'worker_unavailable', error: 'Mac screen is locked; unlock it so Chrome can run claims'};

test('a Mac that cannot take claims stops the run after one try, sends one message, and is asked again in 15 min', async () => {
  const s = claimer({accounts: ['a', 'b', 'c'].map(acct), results: [{...LOCKED}], ready: [{ready: false, reason: 'Mac screen is locked; unlock it so Chrome can run claims'}]});
  const counts = await s.api.runOnce();
  // b and c are still synced, but not sent to a Mac that just refused.
  assert.deepEqual(s.attempts, ['a']); assert.equal(counts.pendingClaims, 3);
  assert.equal(s.pings.length, 1);
  assert.match(s.pings[0], /waiting for the Mac: Mac screen is locked/); assert.match(s.pings[0], /3 claim\(s\) pending/);
  assert.equal(s.api.status().macDown.status, 'worker_unavailable');
  assert.equal(s.api.nextDelay(), 15 * 60000);
  // The next tick asks the Mac first: still locked, so no run at all.
  assert.equal(await s.api.macStillDown(), true); assert.equal(s.probes.length, 1);
  // Refused again within 6 h: no second message.
  s.results.push({...LOCKED}); await s.api.runOnce(); assert.equal(s.pings.length, 1);
  // Unlocked: the check passes, the run claims everyone and clears the state.
  assert.equal(await s.api.macStillDown(), false);
  await s.api.runOnce();
  assert.deepEqual(s.attempts, ['a', 'a', 'a', 'b', 'c']); assert.equal(s.pings.length, 1);
  assert.equal(s.api.status().macDown, null); assert.equal(s.api.nextDelay(), 6 * 3600000);
});

test('a claim this server is already running pauses the scheduled run without a message', async () => {
  const s = claimer({accounts: ['a', 'b'].map(acct), results: [{attempted: false, status: 'busy', local: true, error: 'A claim is already running'}]});
  await s.api.runOnce();
  assert.deepEqual(s.attempts, ['a']); assert.equal(s.pings.length, 0); assert.equal(s.api.nextDelay(), 15 * 60000);
});

test('without an earlier refusal the scheduler never probes the Mac first', async () => {
  const s = claimer({accounts: [acct('a')]});
  assert.equal(await s.api.macStillDown(), false); assert.equal(s.probes.length, 0);
});
