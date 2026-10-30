// Epic's checkout limit (HTTP 429 on confirm-order): repeated 429s get longer
// pauses, checkouts are spaced out, and the page shows the pause instead of
// Claim buttons that can only fail.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createBackoff} = require('../utils/epicClaimBackoff');
const {createClaimBatch} = require('../utils/epicClaimBatch');
const region = require('../utils/epicRegion');
const H = 3600000, GAP = 5 * 60000;

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-backoff-'));
  return {file: path.join(dir, 'cooldown.json'), done: () => fs.rmSync(dir, {recursive: true})};
}

test('a 429 soon after a pause ends doubles the next pause, up to a day', () => {
  const {file, done} = tempFile(); let now = 0;
  const b = () => createBackoff({file, now: () => now});
  assert.equal(b().block(), 6 * H);
  now = 6 * H + 60000; assert.equal(b().block(), now + 12 * H);
  now += 12 * H + 60000; assert.equal(b().block(), now + 24 * H);
  now += 24 * H + 60000; assert.equal(b().block(), now + 24 * H);
  // Epic answered a checkout normally: the next 429 starts from 6 h again.
  now += 24 * H + 60000; b().settle(); assert.equal(b().block(), now + 6 * H);
  // A 429 long after the last pause ended also starts from 6 h.
  now += 6 * H + 13 * H; assert.equal(b().block(), now + 6 * H);
  // Epic's own Retry-After wins.
  now += 6 * H + 60000; assert.equal(b().block(600), now + 600000);
  done();
});

test('a pause written before this change counts as six hours, and settle never shortens a live pause', () => {
  const {file, done} = tempFile(); let now = 1000;
  fs.writeFileSync(file, JSON.stringify({until: 1000, reason: 'Epic checkout HTTP 429'}));
  now = 61000; assert.equal(createBackoff({file, now: () => now}).block(), now + 12 * H);
  const b = createBackoff({file, now: () => now});
  b.settle();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).seconds, 12 * 3600);
  assert.equal(b.until(), now + 12 * H);
  done();
});

const offer = {offerId: 'closed', namespace: 'ns-closed', title: "Sorry We're Closed", active: true};
const account = id => ({_id: id, accountId: id.padEnd(32, '0'), displayName: id, status: 'ok', library: [], autoClaimLog: [], save: async () => {}});

function orchestrator({env = {}, worker}) {
  let calls = 0, settles = 0; const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicAutoClaim'), 'utf8'), {module, exports: module.exports, Date, Buffer, Set, Map,
    process: {env: {EPIC_CLAIM_WORKER_URL: 'http://worker', EPIC_CLAIM_WORKER_TOKEN: 'fixture', ...env}}, require: n => {
      if (n === './epicClaimBackoff') return {until: () => 0, block: () => Date.now() + 60000, settle: () => settles++};
      if (n === 'axios') return {post: async () => { const r = worker(++calls); return typeof r === 'number' ? {status: r, data: {}} : {status: 200, data: r}; }};
      if (n === './epicOfferWindow') return require('../utils/epicOfferWindow');
      if (n === './epicRegion') return region;
      if (n === './epicClient') return {exchangeCode: async () => 'code', getLibraryRecords: async () => []};
      if (n === './epicClaimResult') return {verifyClaimResult: async r => r};
      if (n === './epicAccountToken') return {accountAccessToken: async () => 'access'};
      if (n === './settings') return {getEpicAutoClaim: () => ({enabled: true, dailyCap: 20, perAccountCooldownH: 0})};
      if (n === './captchaSolver') return {detectProvider: () => ''};
      if (n === './secretBox') return {decrypt: v => v}; throw Error(n);
    }});
  return {api: module.exports, calls: () => calls, settles: () => settles};
}

test('checkouts that reach Epic are spaced five minutes apart, and the answer comes at once', async () => {
  const s = orchestrator({worker: () => ({status: 'claimed'})});
  const before = Date.now();
  assert.equal((await s.api.attemptAutoClaim(account('a'), offer, 'access')).status, 'claimed');
  assert.equal(s.settles(), 1);
  const b = account('b');
  const second = await s.api.attemptAutoClaim(b, offer, 'access');
  assert.equal(second.status, 'spacing'); assert.equal(second.attempted, false); assert.equal(s.calls(), 1);
  const gap = Date.parse(second.retryAt) - before;
  assert.ok(gap >= GAP - 50 && gap <= GAP + 5000, 'gap ' + gap);
  assert.equal(b.autoClaimLog.length, 0);
  assert.equal((await s.api.attemptAutoClaim(account('c'), offer, 'access', {manual: true})).status, 'spacing');
  const st = s.api.getStatus();
  assert.equal(st.checkoutGapMin, 5); assert.equal(st.nextCheckoutAt, second.retryAt);
});

test('a busy Mac does not start the gap, and EPIC_CHECKOUT_GAP_MIN=0 turns it off', async () => {
  const busy = orchestrator({worker: n => n === 1 ? 409 : {status: 'claimed'}});
  assert.equal((await busy.api.attemptAutoClaim(account('a'), offer, 'access')).status, 'busy');
  assert.equal((await busy.api.attemptAutoClaim(account('b'), offer, 'access')).status, 'claimed');
  const off = orchestrator({env: {EPIC_CHECKOUT_GAP_MIN: '0'}, worker: () => ({status: 'claimed'})});
  assert.equal((await off.api.attemptAutoClaim(account('a'), offer, 'access')).status, 'claimed');
  assert.equal((await off.api.attemptAutoClaim(account('b'), offer, 'access')).status, 'claimed');
  assert.equal(off.calls(), 2);
});

test('the scheduler waits out the gap and claims the same game, with no Telegram ping', async () => {
  const module = {exports: {}}, waits = [], pings = [], attempts = [];
  const results = [{attempted: false, status: 'spacing', retryAt: new Date(Date.now() + 60000).toISOString()}, {attempted: true, status: 'claimed'}];
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicClaimer'), 'utf8'), {module, exports: module.exports, Date, Map, Set, Math, Number, console, process: {env: {}},
    setTimeout: (f, ms) => { waits.push(ms); f(); return {}; }, require: n => {
      if (n === '../models/EpicAccount' || n === '../models/EpicFreebie') return {};
      if (n === './epicClient') return {getLibraryRecords: async () => []};
      if (n === './epicAutoClaim') return {attemptAutoClaim: async acc => { attempts.push(acc.displayName); return results.shift(); }};
      if (n === './epicAccountToken') return {accountAccessToken: async () => 'access'};
      if (n === './telegram') return {sendTelegram: async text => pings.push(text)};
      if (n === './epicClaimBackoff') return {until: () => 0};
      if (n === './epicRegion') return region;
      if (n === './epicOfferWindow') return require('../utils/epicOfferWindow');
      throw Error(n);
    }});
  const counts = await module.exports.processAccount(account('a'), [offer], true, new Map());
  assert.deepEqual(attempts, ['a', 'a']);
  assert.equal(waits.length, 1); assert.ok(waits[0] >= 60000 && waits[0] <= 62000, 'waited ' + waits[0]);
  assert.equal(pings.length, 0); assert.equal(counts.missing, 1);
});

test('Claim all waits out the gap; stopping during the wait leaves the game pending', async () => {
  let run, calls = 0; const waits = [];
  const later = () => new Date(Date.now() + 60000).toISOString();
  const batch = createClaimBatch({plan: async () => [{accountId: 'a', offerId: 'o', state: 'pending'}], schedule: f => run = f,
    wait: async ms => { waits.push(ms); }, execute: async () => ++calls === 1 ? {status: 'spacing', retryAt: later()} : {status: 'claimed'}});
  await batch.start(); await run();
  assert.equal(calls, 2); assert.equal(waits.length, 1);
  assert.equal(batch.status().state, 'complete'); assert.equal(batch.status().jobs[0].state, 'claimed');

  let stopping, stopCalls = 0, runStop;
  stopping = createClaimBatch({plan: async () => [{accountId: 'a', offerId: 'o', state: 'pending'}, {accountId: 'b', offerId: 'o', state: 'pending'}],
    schedule: f => runStop = f, wait: async () => { stopping.stop(); }, execute: async () => { stopCalls++; return {status: 'spacing', retryAt: later()}; }});
  await stopping.start(); await runStop();
  assert.equal(stopCalls, 1);
  assert.equal(stopping.status().state, 'stopped');
  assert.deepEqual(stopping.status().jobs.map(j => j.state), ['pending', 'pending']);
});

test('while Epic has claims paused the page shows the time instead of Claim buttons', async () => {
  const html = fs.readFileSync(require.resolve('../public/epic-accounts.html'), 'utf8');
  const source = html.slice(html.indexOf('      var countrySources'), html.indexOf('      function render()'));
  const context = {Date, String, isNaN, esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')};
  vm.runInNewContext(source, context);
  const acc = {_id: 'x', missingLive: [{offerId: 'live', title: 'Free Game'}]};
  assert.match(context.missingHtml(acc), /claimNow\(/);
  const until = new Date(Date.now() + 2 * H);
  context.claimPausedUntil = until.toISOString();
  const out = context.missingHtml(acc);
  assert.doesNotMatch(out, /claimNow\(/); assert.match(out, /disabled/);
  assert.ok(out.includes('Paused until ' + context.pauseLabel()));
  context.claimPausedUntil = new Date(Date.now() - 1000).toISOString();
  assert.equal(context.pauseLabel(), ''); assert.match(context.missingHtml(acc), /claimNow\(/);

  // The Claim all button follows the same pause.
  const el = () => ({disabled: false, hidden: false, textContent: '', addEventListener() {}, replaceChildren() {}, appendChild() {}});
  const nodes = {btnClaimAll: el(), btnStopClaims: el(), claimBatchProgress: el()};
  const page = {window: {}, document: {getElementById: id => nodes[id]}, setInterval: () => 0, Promise};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/epic-claim-batch.js'), 'utf8'), page);
  page.window.initEpicClaimBatch({api: async () => ({batch: {state: 'idle', total: 0, completed: 0, jobs: []}}), load() {}, toast() {}, pausedUntil: () => '19:28'});
  await new Promise(r => setImmediate(r));
  assert.equal(nodes.btnClaimAll.disabled, true); assert.equal(nodes.btnClaimAll.textContent, 'Paused until 19:28');
});
