import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { prepareInstance } from '../setup.mjs';
import { INSTANCE, validateHostPairing } from '../lib/instance.mjs';
import { HostCoordinator } from '../lib/host-coordinator.mjs';
import { createHelper } from '../server.mjs';

const template = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
async function installation(t) {
  const path = await mkdtemp(join(tmpdir(), 'fourth-fresh-setup-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'extension')); await writeFile(join(path, 'extension/manifest.json'), JSON.stringify(template));
  return { path, root: pathToFileURL(path + '/'), read: async name => JSON.parse(await readFile(join(path, name), 'utf8')) };
}

test('two fresh fourth setups generate independent held identities without any account, grant or delivery state', async t => {
  assert.equal(template.key, undefined);
  const a = await installation(t), b = await installation(t);
  const [first, second] = await Promise.all([prepareInstance(a), prepareInstance(b)]);
  assert.notEqual(first.extensionId, second.extensionId);
  const x = await a.read('private/config.json'), y = await b.read('private/config.json');
  assert.notEqual(x.pairingToken, y.pairingToken); assert.notEqual((await a.read('extension/manifest.json')).key, (await b.read('extension/manifest.json')).key);
  assert.equal(first.clientId, 'fourth'); assert.equal(first.helperPort, 8797);
  assert.equal(first.serviceLabel, 'local.stream-companion.fourth-helper'); assert.equal(x.hostClientId, 'fourth');
  assert.equal(first.accountBound, false); assert.equal(first.held, true); assert.equal(x.apiKey, '');
  assert.deepEqual(await a.read('private/control-intent.json'), { version: 1, held: true });
  assert.deepEqual((await readdir(join(a.path, 'private'))).sort(), ['config.json', 'control-intent.json']);
  for (const file of ['config.json', 'control-intent.json']) assert.equal((await stat(join(a.path, 'private', file))).mode & 0o777, 0o600);
  assert.equal((await stat(join(a.path, 'private'))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')).key, undefined);
});

test('setup reruns preserve installed identity, pairing, model configuration, held intent and every existing journal', async t => {
  const a = await installation(t); const original = await prepareInstance(a);
  const config = await a.read('private/config.json'); config.model = 'fixture-model'; config.apiKey = 'fixture-provider-only';
  await writeFile(join(a.path, 'private/config.json'), JSON.stringify(config));
  const journals = { 'twitch-send-history.json': [{ delivery: 'unknown', text: 'already attempted' }],
    'host-completions.json': { pending: [{ reservationId: 'old-uncertain', delivery: 'unknown' }] },
    'twitch-oauth.json': { account: 'fixture_fourth' }, 'host.json': { clientId: 'fourth', account: 'fixture_fourth' } };
  for (const [file, value] of Object.entries(journals)) await writeFile(join(a.path, 'private', file), JSON.stringify(value));
  const before = Object.fromEntries(await Promise.all(Object.keys(journals).map(async file => [file, await readFile(join(a.path, 'private', file), 'utf8')])));
  const next = await prepareInstance(a);
  assert.equal(next.extensionId, original.extensionId); assert.equal((await a.read('private/config.json')).pairingToken, config.pairingToken);
  assert.equal((await a.read('private/config.json')).apiKey, config.apiKey);
  assert.deepEqual(await a.read('private/control-intent.json'), { version: 1, held: true });
  for (const file of Object.keys(journals)) assert.equal(await readFile(join(a.path, 'private', file), 'utf8'), before[file]);
  await writeFile(join(a.path, 'private/control-intent.json'), JSON.stringify({ version: 1, held: false }));
  await prepareInstance(a);
  assert.equal((await a.read('private/control-intent.json')).held, false, 'rerunning setup does not alter an existing owner intent');
});

test('existing copied private setup without its own manifest key is refused without changing private bytes', async t => {
  const a = await installation(t); await mkdir(join(a.path, 'private'));
  const raw = JSON.stringify({ extensionId: 'another-profile', pairingToken: 'a'.repeat(64), hostClientId: 'third' });
  await writeFile(join(a.path, 'private/config.json'), raw);
  await assert.rejects(prepareInstance(a), /matching extension key/);
  assert.equal(await readFile(join(a.path, 'private/config.json'), 'utf8'), raw);
  assert.equal((await a.read('extension/manifest.json')).key, undefined);
  assert.deepEqual(await readdir(join(a.path, 'private')), ['config.json']);
});

test('corrupt metadata and changed port cannot reset the held journal or expose its contents', async t => {
  const a = await installation(t); await prepareInstance(a);
  await writeFile(join(a.path, 'private/control-intent.json'), '{"private-fixture-content":');
  await assert.rejects(prepareInstance(a), error => /metadata is invalid/.test(error.message) && !/private-fixture-content/.test(error.message));
  const b = await installation(t), manifest = { ...template, host_permissions: ['http://127.0.0.1:8796/*'] };
  await writeFile(join(b.path, 'extension/manifest.json'), JSON.stringify(manifest));
  await assert.rejects(prepareInstance(b), /fixed helper port/);
  await assert.rejects(stat(join(b.path, 'private')), { code: 'ENOENT' });
});

test('fourth host pairing cannot reuse any original profile ID, accountless pairing or remote destination', async t => {
  const valid = { url: INSTANCE.hostURL, clientId: 'fourth', account: 'fixture_fourth', token: 'fixture-fourth-pairing-only-1234567890' };
  assert.deepEqual(validateHostPairing(valid), valid);
  for (const change of [{ clientId: 'primary' }, { clientId: 'test' }, { clientId: 'third' }, { account: '' },
    { url: 'https://outside.example' }, { token: 'short' }]) assert.throws(() => validateHostPairing({ ...valid, ...change }), /fourth companion/);
  const local = await installation(t);
  const coordinator = new HostCoordinator({ config: valid, outboxFile: join(local.path, 'outcomes.json'), autoStart: false });
  await coordinator.loaded; coordinator.close();
  assert.equal(coordinator.config.clientId, 'fourth');
  assert.throws(() => coordinator.register('fixture_third'), /does not match/);
});

test('fourth fixed loopback boundary rejects all three original helper ports and other extension pairings', async t => {
  let calls = 0;
  const twitch = { status: () => { calls++; return {}; }, disconnect() {} };
  const server = createHelper({ config: { extensionId: 'fourth-fixture', pairingToken: 'fourth-local-fixture' }, twitch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (host, origin = 'chrome-extension://fourth-fixture', token = 'fourth-local-fixture') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/twitch/status', method: 'POST',
      headers: { Host: host, Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end('{}');
  });
  for (const port of [8792, 8793, 8796]) assert.equal(await request(`127.0.0.1:${port}`), 403);
  assert.equal(await request('127.0.0.1:8797', 'chrome-extension://third-fixture'), 403);
  assert.equal(await request('127.0.0.1:8797', undefined, 'third-pairing'), 401);
  assert.equal(calls, 0); assert.equal(await request('127.0.0.1:8797'), 200); assert.equal(calls, 1);
});
