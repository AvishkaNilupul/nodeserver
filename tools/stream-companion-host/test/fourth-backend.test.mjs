import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import http from 'node:http';
import { HostStore } from '../lib/store.mjs';
import { SCENES, messageKey } from '../lib/exchanges.mjs';
import { defaultBank, validateBank, upgradeBankForFourth, digest } from '../lib/bank.mjs';
import { createAccountManager } from '../lib/accounts.mjs';
import { createBrowserLauncher, loadBrowserProfiles } from '../lib/browser-launcher.mjs';
import { createClipController } from '../lib/clips.mjs';
import { createStatusLogger } from '../lib/status-log.mjs';
import { createHostServer, REMOTE_PREFIX } from '../server.mjs';

const NOW = 1_800_000_000_000, IDS = ['primary', 'test', 'third', 'fourth'];
const clients = IDS.map((id, index) => ({ id, account: `${id}_account`, token: String.fromCharCode(97 + index).repeat(48) }));
const channel = 'live_channel', streamId = '123456789';
function legacyBank() {
  const bank = defaultBank(); bank.profiles = bank.profiles.filter(x => x.id !== 'fourth');
  for (const entry of bank.entries) entry.accountIds = ['primary', 'test', 'third'];
  bank.profiles[0].chatMode = 'participate'; bank.profiles[1].replySource = 'ai';
  bank.entries[1].accountIds = ['primary', 'third']; bank.entries[2].enabled = false; bank.entries[3].accountIds = ['test'];
  return bank;
}
function imported(store, id, source) {
  const input = { source, importId: `${id}-${source}`, page: 0, final: true, records: [] };
  input.digest = digest(JSON.stringify({ records: input.records, preferences: null }));
  return store.director.importPage(id, input);
}

test('four-profile bank schema is finite; only old shared assignments inherit the fourth', () => {
  const original = legacyBank(), before = JSON.stringify(original), upgraded = upgradeBankForFourth(original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(upgraded.entries.length, 55);
  assert.deepEqual(upgraded.profiles, [...original.profiles, { id: 'fourth', chatMode: 'mentions', replySource: 'local' }]);
  assert.deepEqual(upgraded.entries[0].accountIds, ['fourth', 'primary', 'test', 'third']);
  assert.deepEqual(upgraded.entries[1].accountIds, ['primary', 'third']);
  assert.equal(upgraded.entries[2].enabled, false); assert.deepEqual(upgraded.entries[2].accountIds, ['fourth', 'primary', 'test', 'third']);
  assert.deepEqual(upgraded.entries[3].accountIds, ['test']);
  assert.deepEqual(upgraded.entries.map(x => [x.id, x.kind, x.category, x.lines, x.enabled]), original.entries.map(x => [x.id, x.kind, x.category, x.lines, x.enabled]));
  assert.equal(upgradeBankForFourth(upgraded), null);
  assert.throws(() => validateBank(original), /invalid|required/);
  assert.throws(() => validateBank({ ...upgraded, profiles: [...upgraded.profiles, { id: 'fifth', chatMode: 'mentions', replySource: 'local' }] }));
  assert.throws(() => validateBank({ ...upgraded, entries: [{ ...upgraded.entries[0], accountIds: ['fifth'] }] }));
  assert.throws(() => upgradeBankForFourth({ ...original, profiles: original.profiles.slice(0, 2) }));
});

test('system migration metadata cannot hide a valid owner save request', t => {
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true, now: () => NOW }); t.after(() => store.close());
  const before = store.director.status();
  assert.throws(() => store.director.saveBank({ requestId: 'migration/fourth/v1', expectedRevision: before.revision, bank: before.bank }), /identifier/);
  const requestId = 'migration:owner-save';
  const saved = store.director.saveBank({ requestId, expectedRevision: before.revision, bank: before.bank });
  assert.deepEqual(store.director.status().lastMutation, { requestId, revision: saved.revision });
});

test('persisted revision five upgrades once without resetting old versions, history, imports, scenes or consumed greetings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-bank-upgrade-')), file = join(directory, 'host.sqlite');
  let time = NOW, store = new HostStore({ file, clients: clients.slice(0, 3), directorEnabled: true, now: () => time });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const client of clients.slice(0, 3)) for (const source of ['helper', 'browser']) imported(store, client.id, source);
  const oldBank = legacyBank(); store.db.exec('DELETE FROM director_banks');
  for (let revision = 1; revision <= 5; revision++) store.db.prepare('INSERT INTO director_banks VALUES (?,?,?,?)').run(revision, JSON.stringify(oldBank), NOW - 10000 + revision, `previous-${revision}`);
  for (let index = 0; index < 22; index++) {
    const at = NOW - 3_600_001 - index, textKey = messageKey(`old line ${index}`), delivery = index < 20 ? 'confirmed' : 'rejected';
    const historicalStream = index === 21 ? '987654321' : streamId;
    store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(`legacy-${index}`, clients[0].account, channel, historicalStream, 'greeting', textKey, '', at, delivery);
    store.director.writeHistory({ attemptId: `legacy-${index}`, clientId: 'primary', account: clients[0].account,
      channel, streamId: historicalStream, kind: 'greeting', text: index % 2 ? null : `old line ${index}`, textKey, delivery, source: 'legacy', at, submitted: true });
  }
  store.db.prepare('INSERT INTO host_used_scenes(channel,scene_id,used_at) VALUES (?,?,?)').run(channel, SCENES[0].id, NOW - 10000);
  for (const kind of ['greeting', 'topic']) store.director.opportunity(`participation:${clients[0].account}:${channel}:${streamId}:${kind}`, clients[0].account, channel, streamId, kind, NOW - 3_600_001, 'unknown');
  const previousVersions = store.db.prepare('SELECT * FROM director_banks ORDER BY revision').all();
  const previousHistory = store.db.prepare('SELECT * FROM director_history ORDER BY id').all();
  const previousImports = store.db.prepare('SELECT * FROM director_import_sources ORDER BY client_id,source').all();
  const previousScenes = store.db.prepare('SELECT * FROM host_used_scenes').all();
  store.close(); time += 60000; store = new HostStore({ file, clients, directorEnabled: true, now: () => time });
  let status = store.director.status(); assert.equal(status.revision, 6); assert.equal(status.lastMutation, null);
  assert.deepEqual(store.db.prepare('SELECT * FROM director_banks WHERE revision<=5 ORDER BY revision').all(), previousVersions);
  assert.deepEqual(store.db.prepare('SELECT * FROM director_history ORDER BY id').all(), previousHistory);
  assert.deepEqual(store.db.prepare('SELECT * FROM director_import_sources ORDER BY client_id,source').all(), previousImports);
  assert.deepEqual(store.db.prepare('SELECT * FROM host_used_scenes').all(), previousScenes);
  assert.equal(store.director.consumed(`participation:${clients[0].account}:${channel}:987654321:greeting`), true, 'legacy consumption is backfilled even when canonical history already exists');
  assert.equal(status.bank.entries.length, 55); assert.equal(status.history.length, 22); assert.equal(status.ready, false);
  assert.deepEqual(status.bank, upgradeBankForFourth(oldBank));
  assert.throws(() => store.director.saveBank({ requestId: 'stale-revision-five', expectedRevision: 5, bank: status.bank }), /changed/);
  assert.equal(store.director.imports('fourth').helper, false);
  imported(store, 'fourth', 'helper'); assert.equal(store.director.ready, false);
  imported(store, 'fourth', 'browser'); assert.equal(store.director.ready, true);
  assert.equal(store.director.status().imports.filter(x => x.complete).length, 4);
  store.sync('primary', { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: time }, seed: [] });
  const observation = { protocol: 1, binding: { generation: 'generation', sessionId: 'browser', settingsRevision: 1 }, armed: true,
    streamContext: { channel, streamId, gameName: 'Art', title: 'Current title', isLive: true, checkedAt: time }, messages: [],
    restrictions: { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false } };
  assert.equal(store.director.observe('primary', observation).director.plan, undefined, 'consumed old greeting/topic cannot replay');
  assert.equal(store.director.history('fourth').history.length, 0);
  store.close(); time += 60000; store = new HostStore({ file, clients, directorEnabled: true, now: () => time });
  status = store.director.status(); assert.equal(status.revision, 6); assert.equal(status.ready, true); assert.equal(status.plans.length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM director_banks').get().n, 6);
  assert.deepEqual(store.db.prepare('SELECT * FROM director_history ORDER BY id').all(), previousHistory);
  assert.deepEqual(store.db.prepare('SELECT * FROM host_used_scenes').all(), previousScenes);
});

test('browser mappings retain old rosters and launch the fourth only from its own verified directory', async () => {
  const two = { primary: 'Profile 21', test: 'Profile 22' }, three = { ...two, third: 'Profile 23' }, four = { ...three, fourth: 'Profile 24' };
  for (const value of [two, three, four]) assert.deepEqual(await loadBrowserProfiles({ readFileImpl: async () => JSON.stringify(value) }), value);
  for (const value of [{ ...four, fourth: three.third }, { ...three, fourth: '../Profile 24' }, { ...two, fourth: 'Profile 24' }, { ...four, fifth: 'Profile 25' }])
    await assert.rejects(loadBrowserProfiles({ readFileImpl: async () => JSON.stringify(value) }), /invalid/);
  const calls = [], launcher = createBrowserLauncher({ profiles: four, platform: 'darwin', spawnImpl: (binary, args, options) => {
    calls.push({ binary, args, options }); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  assert.equal(createBrowserLauncher({ profiles: three, platform: 'darwin' }).available('fourth'), false);
  assert.equal(launcher.available('fourth'), true); assert.equal(calls.length, 0);
  await launcher.open('fourth', 'fourth-open');
  assert.deepEqual(calls[0].args, ['--profile-directory=Profile 24', '--new-window', 'http://127.0.0.1:8795/accounts/fourth']);
  assert.equal(calls[0].options.shell, false);
  await assert.rejects(launcher.open('fifth', 'unknown'), /Unknown/); assert.equal(calls.length, 1);
});

test('the fourth companion is excluded from human targets for every original profile', t => {
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true, now: () => NOW }); t.after(() => store.close());
  for (const client of clients) for (const source of ['helper', 'browser']) imported(store, client.id, source);
  for (const client of clients.slice(0, 3)) {
    store.sync(client.id, { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: NOW }, seed: [] });
    const base = { protocol: 1, binding: { generation: 'generation', sessionId: `browser-${client.id}`, settingsRevision: 1 }, armed: true,
      streamContext: { channel, streamId, gameName: 'Art', title: 'Current title', isLive: true, checkedAt: NOW },
      restrictions: { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false } };
    const peer = { id: `peer-${client.id}`, author: clients[3].account, text: `@${client.account} hello`, at: NOW, channel };
    assert.equal(store.director.observe(client.id, { ...base, messages: [peer] }).director.plan, undefined);
    const human = { ...peer, id: `human-${client.id}`, author: 'real_viewer' };
    const result = store.director.observe(client.id, { ...base, messages: [human, peer] }).director.plan;
    assert.equal(result.replyId, human.id); assert.equal(result.replyAuthor, 'real_viewer');
  }
  assert.equal(store.director.history().history.length, 0, 'planning cannot create a delivery');
});

test('fourth account adapter uses only its fixed port and pairing and redacts setup details', async () => {
  const config = { extensionId: 'd'.repeat(32), pairingToken: 'fourth-pairing-fixture-'.repeat(3) }, calls = [];
  const manager = createAccountManager({ sources: [{ id: 'fourth', configPath: 'fourth-fixture.json' }], now: () => NOW,
    readFileImpl: async () => JSON.stringify(config), fetchImpl: async (url, options) => {
      calls.push({ url, options }); assert.equal(new URL(url).port, '8797'); assert.equal(options.headers.Origin, `chrome-extension://${config.extensionId}`);
      assert.equal(options.headers.Authorization, `Bearer ${config.pairingToken}`);
      return Response.json({ ok: true, account: clients[3].account, authorized: true, connected: false, settings: { paused: true }, browser: { online: false } });
    } });
  const result = await manager.snapshot(); assert.deepEqual(result.instances.map(x => x.id), ['fourth']); assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fourth-pairing-fixture|dddddddddddddddddddddddddddddddd/);
  assert.throws(() => createAccountManager({ sources: [{ id: 'fourth', port: 8796 }] }), /Unsupported/);
});

test('all fifteen clip selections remain exact and existing three-account settings never widen', async t => {
  const store = new HostStore({ file: ':memory:', clients }), calls = [];
  const accounts = { snapshot: async () => ({ instances: [] }), clipStatus: async id => ({ ok: true, account: clients.find(x => x.id === id).account, authorized: false, jobs: [] }),
    clipCreate: async (...args) => { calls.push(args); throw Error('No clip may be created while selecting accounts.'); }, clipAuthorization: async () => { throw Error('No grant requested.'); } };
  const controller = createClipController({ db: store.db, accounts, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  t.after(async () => { await controller.close(); store.close(); });
  for (let mask = 1; mask < 16; mask++) {
    const accountIds = IDS.filter((_, index) => mask & 1 << index);
    controller.configure({ enabled: false, channel, accountIds }); assert.deepEqual(controller.snapshot().settings.accountIds, accountIds);
  }
  controller.configure({ enabled: false, channel, accountIds: IDS.slice(0, 3) });
  await controller.close();
  const reopened = createClipController({ db: store.db, accounts, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot().settings.accountIds, ['primary', 'test', 'third']); assert.equal(reopened.snapshot().settings.enabled, false);
  assert.deepEqual(reopened.snapshot().accounts.map(x => x.id), IDS); assert.equal(calls.length, 0);
  assert.throws(() => reopened.configure({ enabled: false, channel, accountIds: ['fifth'] }));
});

test('fourth status logging keeps the same credential-free fixed projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fourth-status-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logger = createStatusLogger({ directory, now: () => NOW });
  assert.equal(logger.observe({ instances: [{ id: 'fourth', available: true, authorized: true, connected: false,
    account: 'PRIVATE_ACCOUNT', channel: 'PRIVATE_CHANNEL', settings: { paused: true, pairingToken: 'PRIVATE_TOKEN' }, browser: { online: false } }] }), true);
  const text = await readFile(join(directory, 'status.jsonl'), 'utf8'); assert.doesNotMatch(text, /PRIVATE/);
  assert.equal(JSON.parse(text.trim()).profile, 'fourth');
});

test('fourth page, browser, commands and history remain finite and protected through both Mac mounts', async t => {
  const calls = [], store = new HostStore({ file: ':memory:', clients, directorEnabled: true }), token = 'remote-fourth-fixture-'.repeat(3), csrfToken = 'fourth-csrf';
  const accounts = { snapshot: async () => ({ instances: [] }), command: async (id, body) => { calls.push({ id, body }); return { ok: true }; } };
  const browserLauncher = { available: id => id === 'fourth', open: async (id, requestId) => { calls.push({ id, requestId }); return { ok: true }; } };
  const server = createHostServer({ store, clients, accounts, browserLauncher, remoteToken: token, csrfToken, readFileImpl: async () => Buffer.from('<html><head></head><body>Fixture</body></html>') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = (path, { method = 'GET', body, remote = false, csrf = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: '127.0.0.1:8795', Origin: 'http://127.0.0.1:8795', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...(remote ? { Authorization: `Bearer ${token}` } : {}), ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) } }, res => {
      let text = ''; res.on('data', x => text += x); res.on('end', () => resolve({ status: res.statusCode, text }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  for (const prefix of ['', REMOTE_PREFIX]) {
    const remote = !!prefix;
    assert.equal((await request(prefix + '/accounts/fourth', { remote })).status, 200); assert.equal(calls.length, remote ? 2 : 0);
    assert.equal((await request(prefix + '/api/director/history/fourth/0', { remote })).status, 200);
    assert.equal((await request(prefix + '/api/accounts/fourth/browser', { method: 'POST', remote, body: { requestId: 'open' } })).status, 403);
    assert.equal((await request(prefix + '/api/accounts/fourth/browser', { method: 'POST', remote, csrf: true, body: { requestId: 'open' } })).status, 200);
    assert.equal((await request(prefix + '/api/accounts/fourth/command', { method: 'POST', remote, csrf: true, body: { requestId: 'stop', action: 'stop', params: {} } })).status, 200);
    const before = calls.length;
    for (const path of ['/api/accounts/fifth/browser', '/api/accounts/fourth/browser/', '/api/accounts/fourth/browser?x=1', '/api/director/history/fifth/0'])
      assert.ok((await request(prefix + path, { method: 'POST', remote, csrf: true, body: { requestId: 'bad' } })).status >= 400);
    assert.equal(calls.length, before);
  }
  assert.equal((await request(REMOTE_PREFIX + '/accounts/fourth')).status, 403);
});
