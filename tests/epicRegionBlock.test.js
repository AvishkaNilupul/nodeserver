// Region-locked Epic giveaways: Epic's "not available in your region" answer
// locks the pair for good and locks every account from the same country, in
// the scheduler, the Claim-all batch, the manual button and the page.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const region = require('../utils/epicRegion');
const {createClaimBatch, planClaims} = require('../utils/epicClaimBatch');

const details = d => JSON.stringify(d);
const offer = {offerId: 'closed', namespace: 'ns-closed', title: "Sorry We're Closed", active: true};
const ru = (id, log = []) => ({_id: id, accountId: id.padEnd(32, '0'), displayName: id, status: 'ok', library: [],
  accountDetails: details({creationCountry: 'RU', creationCountrySource: 'recorded-account-country', country: 'RU'}), autoClaimLog: log});
const refused = {offerId: 'closed', status: 'region_unavailable', at: new Date()};

test('country comes from the signup region detector first, then the recorded country', () => {
  assert.deepEqual(region.accountCountry({accountDetails: details({creationCountry: 'us', creationCountrySource: 'proxy-ip', country: 'JP'})}), {country: 'US', source: 'proxy-ip'});
  assert.deepEqual(region.accountCountry({accountDetails: details({country: 'br'})}), {country: 'BR', source: 'recorded-account-country'});
  assert.deepEqual(region.accountCountry({accountDetails: '{not json'}), {country: '', source: ''});
  assert.deepEqual(region.accountCountry({}), {country: '', source: ''});
});

test('one refusal locks that account and every account from the same country, only for that giveaway', () => {
  const accounts = [ru('a', [refused]), ru('b'), {...ru('c'), accountDetails: details({country: 'JP'})}, {...ru('d', [refused]), accountDetails: ''}];
  const blocked = region.blockedCountries(accounts);
  assert.deepEqual([...blocked.get('closed')], ['RU']);
  assert.deepEqual(region.regionBlock(accounts[0], offer, blocked), {country: 'RU', reason: 'epic'});
  assert.deepEqual(region.regionBlock(accounts[1], offer, blocked), {country: 'RU', reason: 'country'});
  assert.equal(region.regionBlock(accounts[2], offer, blocked), null);
  assert.deepEqual(region.regionBlock(accounts[3], offer, blocked), {country: '', reason: 'epic'});
  assert.equal(region.regionBlock(accounts[1], {...offer, offerId: 'other'}, blocked), null);
  const fresh = new Map();region.noteRefusal(fresh, accounts[2], 'closed');assert.deepEqual([...fresh.get('closed')], ['JP']);
});

function orchestrator(worker) {
  let calls = 0, pausedUntil = 0; const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicAutoClaim'), 'utf8'), {module, exports: module.exports, Date, Buffer, Set, Map,
    process: {env: {EPIC_CLAIM_WORKER_URL: 'http://worker', EPIC_CLAIM_WORKER_TOKEN: 'fixture'}}, require: n => {
      if (n === './epicClaimBackoff') return {until: () => pausedUntil, block: () => pausedUntil = Date.now() + 60000};
      if (n === 'axios') return {post: async () => { calls++; return {status: 200, data: worker()}; }};
      if (n === './epicOfferWindow') return require('../utils/epicOfferWindow');
      if (n === './epicRegion') return region;
      if (n === './epicClient') return {exchangeCode: async () => 'code', getLibraryRecords: async () => []};
      if (n === './epicClaimResult') return {verifyClaimResult: async r => r};
      if (n === './epicAccountToken') return {accountAccessToken: async () => 'access'};
      if (n === './settings') return {getEpicAutoClaim: () => ({enabled: true, dailyCap: 20, perAccountCooldownH: 0})};
      if (n === './captchaSolver') return {detectProvider: () => ''};
      if (n === './secretBox') return {decrypt: v => v}; throw Error(n);
    }});
  return {api: module.exports, calls: () => calls, pause: () => pausedUntil = Date.now() + 60000};
}
const withSave = a => Object.assign(a, {save: async () => {}});

test("Epic's refusal is logged, gives the cap slot back and is never retried", async () => {
  const s = orchestrator(() => ({status: 'region_unavailable', error: 'Epic says this product is not available'}));
  const a = withSave(ru('a'));
  const first = await s.api.attemptAutoClaim(a, offer, 'access');
  assert.equal(first.status, 'region_unavailable');assert.equal(a.autoClaimLog[0].status, 'region_unavailable');
  assert.equal(s.api.getStatus().todayCount, 0);
  const again = await s.api.attemptAutoClaim(a, offer, 'access', {manual: true});
  assert.equal(again.status, 'region_blocked');assert.equal(again.country, 'RU');assert.equal(s.calls(), 1);
  assert.match(again.error, /Not available in RU/);
});

test('another account from a refused country never reaches checkout, even while Epic is pausing claims', async () => {
  const s = orchestrator(() => ({status: 'claimed'}));
  const blocked = new Map([['closed', new Set(['RU'])]]);
  s.pause();
  const r = await s.api.attemptAutoClaim(withSave(ru('b')), offer, 'access', {blocked});
  assert.equal(r.status, 'region_blocked');assert.equal(r.reason, 'country');assert.equal(s.calls(), 0);
  const other = await s.api.attemptAutoClaim(withSave({...ru('c'), accountDetails: details({country: 'JP'})}), offer, 'access', {blocked});
  assert.equal(other.status, 'rate_limited');
});

test('Claim all leaves region-locked pairs out and treats a refusal as an answer, not a failure', async () => {
  const blocked = new Map([['closed', new Set(['RU'])]]);
  const jp = {...ru('jp'), accountDetails: details({country: 'JP'})};
  assert.deepEqual(planClaims([ru('a'), jp], [offer], Date.now(), blocked).map(j => j.accountId), ['jp']);
  let run, calls = 0;
  const batch = createClaimBatch({plan: async () => [{accountId: 'a', offerId: 'closed', state: 'pending'}, {accountId: 'b', offerId: 'closed', state: 'pending'}],
    schedule: f => run = f, execute: async () => (++calls === 1 ? {status: 'region_unavailable', error: 'Not sold here'} : {status: 'region_blocked', error: 'Not available in RU'})});
  await batch.start();await run();
  const st = batch.status();
  assert.equal(calls, 2);assert.equal(st.state, 'complete');assert.equal(st.completed, 2);
  assert.deepEqual(st.jobs.map(j => j.state), ['region_blocked', 'region_blocked']);
});

function claimer({results, pausedUntil = 0}) {
  const module = {exports: {}}, attempts = [], pings = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/epicClaimer'), 'utf8'), {module, exports: module.exports, Date, Map, Set, Math, console, process: {env: {}}, setTimeout, require: n => {
    if (n === '../models/EpicAccount' || n === '../models/EpicFreebie') return {};
    if (n === './epicClient') return {getLibraryRecords: async () => []};
    if (n === './epicAutoClaim') return {attemptAutoClaim: async (acc, f, t, opts) => { attempts.push({acc: acc.displayName, blocked: opts && opts.blocked}); return results.shift(); }};
    if (n === './epicAccountToken') return {accountAccessToken: async () => 'access'};
    if (n === './telegram') return {sendTelegram: async text => pings.push(text)};
    if (n === './epicClaimBackoff') return {until: () => pausedUntil};
    if (n === './epicRegion') return region;
    if (n === './epicOfferWindow') return require('../utils/epicOfferWindow');
    throw Error(n);
  }});
  return {api: module.exports, attempts, pings};
}

test('a refusal in a scheduled run locks the rest of that country in the same run, with no Telegram pings', async () => {
  const s = claimer({results: [{attempted: true, status: 'region_unavailable'}, {attempted: false, status: 'rate_limited'}]});
  const blocked = new Map();
  const a = withSave(ru('ru-1')), b = withSave(ru('ru-2')), jp = withSave({...ru('jp'), accountDetails: details({country: 'JP'})});
  const first = await s.api.processAccount(a, [offer], true, new Map(), blocked);
  const second = await s.api.processAccount(b, [offer], true, new Map(), blocked);
  const third = await s.api.processAccount(jp, [offer], true, new Map(), blocked);
  assert.deepEqual(s.attempts.map(x => x.acc), ['ru-1', 'jp']);
  assert.equal(s.attempts[0].blocked, blocked);
  assert.deepEqual({...first}, {missing: 0, regionLocked: 1});
  assert.deepEqual({...second}, {missing: 0, regionLocked: 1});
  assert.deepEqual({...third}, {missing: 1, regionLocked: 0});
  assert.equal(s.pings.length, 0);
});

test('the claimer wakes shortly after an Epic 429 pause instead of waiting a full 6 hours', () => {
  const six = 6 * 3600000, now = Date.now();
  assert.equal(claimer({results: []}).api.nextDelay(now), six);
  assert.equal(claimer({results: [], pausedUntil: now + 3600000}).api.nextDelay(now), 3600000 + 120000);
  assert.equal(claimer({results: [], pausedUntil: now + 10 * 3600000}).api.nextDelay(now), six);
});

test('the accounts page shows region locks apart, without a Claim button', () => {
  const html = fs.readFileSync(require.resolve('../public/epic-accounts.html'), 'utf8');
  const source = html.slice(html.indexOf('      var countrySources'), html.indexOf('      function render()'));
  const context = {Date, String, isNaN, esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')};
  vm.runInNewContext(source, context);
  const out = context.missingHtml({_id: 'x', missingLive: [{offerId: 'live', title: 'Free <Game>', lastTry: {at: new Date(), status: 'error', error: 'timed out'}}],
    regionLocked: [{offerId: 'closed', title: "Sorry We're Closed", country: 'RU', reason: 'country'}]});
  assert.equal((out.match(/claimNow\(/g) || []).length, 1);
  assert.match(out, /Region locked · RU/);assert.match(out, /Epic refused another RU account/);
  assert.match(out, /Last try .*error · timed out/);assert.doesNotMatch(out, /<Game>/);
  assert.match(context.regionChip({country: 'RU', countrySource: 'proxy-ip'}), /signup IP/);
  assert.equal(context.missingHtml({_id: 'x'}), '<span class="muted">none 🎉</span>');
});
