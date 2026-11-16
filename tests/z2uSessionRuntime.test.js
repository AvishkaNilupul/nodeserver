'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { browserCookieJar, importBrowserSession, openSession } = require('../utils/z2u/session');
const { privatePath, readPrivate, writePrivate, acquireRuntimeLock } = require('../utils/z2u/privateStore');
const { createZ2uClient } = require('../utils/z2u/client');
const { verifyAccess, runCheck, monitor, validateConfig } = require('../utils/z2u/runtime');
const ORIGIN = 'https://www.z2u.com';
const cookie = (value = 'synthetic', extra = {}) => ({ domain: '.z2u.com', name: 'sid', value, path: '/', secure: true, httpOnly: true, hostOnly: false, session: true, ...extra });
const verified = async () => ({ sellerAccess: true, storageAccess: true });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'z2u-session-review-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  return { dir, file: path.join(dir, 'session.json') };
}

test('cookie export preserves path identity and rejects foreign domains or expired-only sessions', () => {
  const jar = browserCookieJar([cookie('root'), cookie('storage', { path: '/userStorage' })]);
  assert.equal(jar.getCookieStringSync(ORIGIN + '/sellOrder'), 'sid=root');
  assert.equal(jar.getCookieStringSync(ORIGIN + '/userStorage/product'), 'sid=storage; sid=root');
  assert.equal(jar.getCookieStringSync('https://attacker.invalid/userStorage/product'), '');
  assert.equal(jar.getCookieStringSync('http://www.z2u.com/userStorage/product'), '');
  assert.throws(() => browserCookieJar([cookie(), cookie('other', { domain: 'attacker.invalid' })]), { code: 'INVALID_COOKIE_EXPORT' });
  assert.throws(() => browserCookieJar([cookie('expired', { session: false, expirationDate: Date.now() / 1000 - 10 })]), { code: 'EMPTY_SESSION' });
});

test('validation cookie rotations are the exact session persisted to disk', async t => {
  const { file } = await fixture(t);
  await importBrowserSession(file, [cookie('before-validation')], async session => {
    await session.acceptResponse(new Response('', { headers: { 'set-cookie': 'sid=after-validation; Domain=z2u.com; Path=/; Secure; HttpOnly' } }), ORIGIN + '/userStorage/product');
    return verified();
  });
  const session = await openSession(file);
  assert.equal((await session.getHeaders(ORIGIN + '/userStorage/product')).Cookie, 'sid=after-validation');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(importBrowserSession(file, [cookie('bad')], async () => ({ sellerAccess: true, storageAccess: false })), { code: 'SESSION_UNVERIFIED' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('set-cookie deletion and domain rejection preserve correct durable scope', async t => {
  const { file } = await fixture(t);
  await importBrowserSession(file, [cookie()], verified);
  const session = await openSession(file);
  await assert.rejects(session.getHeaders('https://attacker.invalid/'), { code: 'INVALID_URL' });
  await assert.rejects(session.acceptResponse(new Response('', { headers: { 'set-cookie': 'sid=bad; Domain=attacker.invalid; Path=/' } }), ORIGIN), { code: 'INVALID_RESPONSE_COOKIE' });
  assert.equal((await session.getHeaders(ORIGIN)).Cookie, 'sid=synthetic');
  await session.acceptResponse(new Response('', { headers: { 'set-cookie': 'sid=; Max-Age=0; Domain=z2u.com; Path=/' } }), ORIGIN);
  await assert.rejects((await openSession(file)).getHeaders(ORIGIN), { code: 'SESSION_EXPIRED' });
});

test('replacement generation prevents old transport from overwriting imported credentials', async t => {
  const { file } = await fixture(t);
  await importBrowserSession(file, [cookie('old')], verified);
  const old = await openSession(file);
  await importBrowserSession(file, [cookie('new')], verified);
  await assert.rejects(old.acceptResponse(new Response('', { headers: { 'set-cookie': 'sid=stale; Domain=z2u.com; Path=/' } }), ORIGIN), { code: 'SESSION_REPLACED' });
  assert.equal((await (await openSession(file)).getHeaders(ORIGIN)).Cookie, 'sid=new');
});

test('generation check and session rename share a lock with concurrent imports', async t => {
  const { file } = await fixture(t);
  await importBrowserSession(file, [cookie('old')], verified);
  const old = await openSession(file);
  let reached, release;
  const paused = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const original = fs.rename;
  fs.rename = async (...args) => {
    if (args[1] === file) { reached(); await resume; }
    return original(...args);
  };
  let write;
  try {
    write = old.acceptResponse(new Response('', { headers: { 'set-cookie': 'sid=rotated; Domain=z2u.com; Path=/' } }), ORIGIN);
    await paused;
    await assert.rejects(importBrowserSession(file, [cookie('new')], verified), { code: 'RUNTIME_LOCKED' });
  } finally { release(); await write; fs.rename = original; }
  await importBrowserSession(file, [cookie('new')], verified);
  assert.equal((await (await openSession(file)).getHeaders(ORIGIN)).Cookie, 'sid=new');
});

test('private store rejects public permissions, symlinks and live lock replacement', async t => {
  const { dir, file } = await fixture(t);
  await writePrivate(file, { synthetic: true });
  await fs.chmod(file, 0o644);
  await assert.rejects(readPrivate(file), { code: 'PRIVATE_FILE_REQUIRED' });
  await fs.chmod(file, 0o600);
  const link = path.join(dir, 'link.json'); await fs.symlink(file, link);
  await assert.rejects(readPrivate(link), { code: 'PRIVATE_FILE_REQUIRED' });
  await assert.rejects(privatePath(path.resolve(__dirname, '../utils/z2u/test-secret.json')), { code: 'PRIVATE_PATH_REQUIRED' });
  const lock = path.join(dir, 'runtime.lock');
  const unlock = await acquireRuntimeLock(lock);
  await assert.rejects(acquireRuntimeLock(lock), { code: 'RUNTIME_LOCKED' });
  await unlock();
  await fs.chmod(dir, 0o755);
  await assert.rejects(readPrivate(file), { code: 'PRIVATE_DIRECTORY_REQUIRED' });
});

const sellerHTML = '<a href="/sellOrder/index/order_status/ALL">All (0)</a>';
const storageHTML = total => `<h1>Storage List (Totals:${total})</h1><div id="productlist"></div>`;
const offer = { offerId: '1', storageId: '2', gameId: '3', categoryId: '4', maxPurchaseQuantity: 1, kind: 'code' };
const config = { version: 1, offers: [offer] };
const client = { readPage: async route => route.includes('sellOrder') ? sellerHTML : storageHTML(1) };
const nativeSettings = { id: '1', storage_id: '2', is_auto_deliver: 1, outstock: 1, is_agiso: 0, buy_more: 1 };
const protocol = { readOfferDelivery: async () => nativeSettings, readStoragePage: async () => storageHTML(1) };

test('actual Node DOM parser verifies both seller and storage access, not login markup', async () => {
  assert.deepEqual(await verifyAccess(client), { sellerAccess: true, storageAccess: true, storageVisible: 1, orderTotal: 0 });
  await assert.rejects(verifyAccess({ readPage: async () => '<form id="login"></form>' }), { code: 'SESSION_UNVERIFIED' });
  assert.throws(() => validateConfig({ version: 1, offers: [offer, offer] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig({ version: 1, offers: [offer, { ...offer, offerId: '99' }] }), { code: 'INVALID_CONFIG' });
  assert.equal(validateConfig({ version: 1, offers: [offer, { ...offer, offerId: '99', storageId: '98' }] }).offers.length, 2);
});

test('offer read failures remain unknown and cannot advance full health success', async () => {
  const failure = Object.assign(new Error('PRIVATE_RESPONSE'), { code: 'READ_FAILED' });
  const report = await runCheck({ client, protocol: { ...protocol, readOfferDelivery: async () => { throw failure; } }, config,
    previous: { lastSuccessAt: 'old-success', consecutiveFailures: 2 }, now: () => 'new-attempt' });
  assert.equal(report.healthy, false);
  assert.equal(report.lastSuccessAt, 'old-success');
  assert.equal(report.accessLastSuccessAt, 'new-attempt');
  assert.equal(report.consecutiveFailures, 3);
  assert.equal(report.alerts[0].state, 'unknown');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_RESPONSE'));
});

test('empty stock and missing reconciliation cannot appear healthy', async () => {
  const empty = await runCheck({ client, protocol: { ...protocol, readStoragePage: async () => storageHTML(0) }, config, checkOffer: async () => ({ ready: true }) });
  assert.equal(empty.healthy, false);
  assert.equal(empty.offers[0].healthy, false);
  const unconnected = await runCheck({ client, protocol, config });
  assert.equal(unconnected.healthy, false);
  assert.ok(unconnected.alerts.some(alert => alert.code === 'OFFER_NOT_READY'));
  const healthy = await runCheck({ client, protocol, config, now: () => 'success', checkOffer: async () => ({ ready: true }), previous: { consecutiveFailures: 2 } });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.lastSuccessAt, 'success');
  assert.equal(healthy.consecutiveFailures, 0);
});

test('offer protection runs despite malformed global storage markup', async () => {
  let guards = 0;
  const changedTemplate = { readPage: async route => route.includes('sellOrder') ? sellerHTML : '<main>Changed storage template</main>' };
  const report = await runCheck({ client: changedTemplate, protocol, config,
    checkOffer: async checked => { guards++; assert.equal(checked.offerId, offer.offerId); return { ready: false, protection: 'expiry_hold', saleReconciliation: 'verified' }; } });
  assert.equal(guards, 1);
  assert.equal(report.healthy, false);
  assert.ok(report.alerts.some(alert => alert.code === 'SESSION_UNVERIFIED'));
  assert.equal(report.protectionChecks[0].protection, 'expiry_hold');
});

test('privacy lock does not skip independent protection or erase a sanitized pause failure', async () => {
  let guards = 0;
  const locked = { readPage: async route => {
    if (route.includes('sellOrder')) return sellerHTML;
    throw Object.assign(new Error('PRIVATE privacy response'), { code: 'PRIVACY_LOCKED' });
  } };
  const report = await runCheck({ client: locked, protocol, config,
    checkOffer: async () => { guards++; return { ready: false, protection: 'pause_unverified', saleReconciliation: 'PRIVATE response', extra: 'PRIVATE payload' }; } });
  assert.equal(guards, 1);
  assert.equal(report.healthy, false);
  assert.equal(report.alerts[0].code, 'PRIVACY_LOCKED');
  assert.deepEqual(report.protectionChecks[0], { offerId: offer.offerId, ready: false, protection: 'pause_unverified', saleReconciliation: 'held' });
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
});

test('successful access reuses cached protection once and guard exceptions remain sanitized', async () => {
  let guards = 0;
  const result = await runCheck({ client, protocol, config, checkOffer: async () => { guards++; return { ready: true, protection: 'verified', saleReconciliation: 'verified' }; } });
  assert.equal(guards, 1);
  assert.equal(result.healthy, true);
  assert.equal(result.protectionChecks.length, 1);
  const failed = await runCheck({ client, protocol, config, checkOffer: async () => { throw new Error('PRIVATE guard failure'); } });
  assert.equal(failed.healthy, false);
  assert.equal(failed.protectionChecks[0].code, 'CHECK_FAILED');
  assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
});

test('offer protection runs before per-offer delivery or inventory parser failures', async () => {
  const events = [];
  const report = await runCheck({ client, config,
    protocol: { readOfferDelivery: async () => { events.push('delivery'); throw Object.assign(new Error('Synthetic'), { code: 'READ_FAILED' }); } },
    checkOffer: async () => { events.push('guard'); return { ready: false, protection: 'expiry_hold' }; } });
  assert.deepEqual(events, ['guard', 'delivery']);
  assert.equal(report.healthy, false);
});

test('shutdown stops between operations without stamping a failed persisted health check', async t => {
  const { dir } = await fixture(t);
  await writePrivate(path.join(dir, 'health.json'), { unchanged: true });
  const controller = new AbortController(); let stockReads = 0;
  const report = await runCheck({ stateDir: dir, client, protocol: { readOfferDelivery: async () => { controller.abort(); return nativeSettings; }, readStoragePage: async () => { stockReads++; return storageHTML(1); } }, config, signal: controller.signal, previous: { consecutiveFailures: 2 } });
  assert.equal(report.aborted, true);
  assert.equal(report.consecutiveFailures, 2);
  assert.equal(stockReads, 0);
  assert.deepEqual(await readPrivate(path.join(dir, 'health.json')), { unchanged: true });
});

test('monitor awaits each cycle and shutdown interrupts its sleep', async () => {
  const controller = new AbortController(); let cycles = 0, active = 0, peak = 0;
  const started = Date.now();
  await monitor({ signal: controller.signal, intervalMs: 60000,
    cycle: async ({ signal }) => { assert.equal(signal, controller.signal); cycles++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return {}; },
    onStatus: () => { setTimeout(() => controller.abort(), 5); },
  });
  assert.equal(cycles, 1); assert.equal(peak, 1); assert.ok(Date.now() - started < 1000);
});

test('client propagates shutdown into an in-flight fetch and preserves write uncertainty', async () => {
  for (const mutation of [false, true]) {
    const controller = new AbortController();
    const remote = createZ2uClient({ intervalMs: 0, signal: controller.signal, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
      setImmediate(() => controller.abort());
    }) });
    await assert.rejects(mutation ? remote.mutate('/write', () => new FormData()) : remote.readPage('/read'), { code: 'ABORTED', uncertain: mutation });
  }
});
