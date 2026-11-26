import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserLauncher, loadBrowserProfiles } from '../lib/browser-launcher.mjs';

const profiles = { primary: 'Profile 21', test: 'Profile 22' };
function fixture({ mode = 'spawn', ...options } = {}) {
  const calls = [], children = []; let time = 100000;
  const spawnImpl = (binary, args, settings) => {
    calls.push({ binary, args, settings });
    if (mode === 'throw') throw Error('PRIVATE_PROCESS_PATH_AND_TOKEN');
    const child = new EventEmitter(); child.unreferenced = false; child.killed = false;
    child.unref = () => { child.unreferenced = true; };
    child.kill = () => { child.killed = true; };
    children.push(child);
    if (mode === 'spawn') queueMicrotask(() => child.emit('spawn'));
    if (mode === 'error') queueMicrotask(() => child.emit('error', Error('PRIVATE_PROFILE_AND_PROCESS_ERROR')));
    return child;
  };
  const launcher = createBrowserLauncher({ profiles, platform: 'darwin', spawnImpl, now: () => time, ...options });
  return { launcher, calls, children, advance: delta => { time += delta; } };
}
const sanitized = error => {
  assert.equal(error.status, 503);
  assert.doesNotMatch(error.message, /PRIVATE|\/Applications|Profile 2|token|ENOENT/);
  return true;
};

test('optional profile configuration is exact, bounded, distinct and independent of caller mutations', async () => {
  const value = await loadBrowserProfiles({ readFileImpl: async () => JSON.stringify(profiles) });
  assert.deepEqual(value, profiles); assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(await loadBrowserProfiles({ readFileImpl: async () => JSON.stringify({ primary: 'Default', test: 'Profile 999' }) }), { primary: 'Default', test: 'Profile 999' });
  assert.equal(await loadBrowserProfiles({ readFileImpl: async () => { throw Object.assign(Error('private path'), { code: 'ENOENT' }); } }), undefined);
  for (const value of [null, [], {}, { primary: 'Profile 21' }, { ...profiles, url: 'https://outside.example' },
    { ...profiles, primary: 'Profile 22' }, { ...profiles, primary: 'Profile 0' }, { ...profiles, primary: 'Profile 01' },
    { ...profiles, primary: 'Profile 1000' }, { ...profiles, primary: '../Profile 21' },
    { ...profiles, primary: 'Profile 21 --remote-debugging-port=1234' }, { ...profiles, primary: 'Profile 21\n' },
    { ...profiles, primary: 'Profile ２１' }]) {
    await assert.rejects(loadBrowserProfiles({ readFileImpl: async () => JSON.stringify(value) }), /^Error: Browser profile setup is invalid\.$/);
  }
  for (const text of ['PRIVATE_JSON_ERROR', ' '.repeat(4097)]) {
    await assert.rejects(loadBrowserProfiles({ readFileImpl: async () => text }), /^Error: Browser profile setup is invalid\.$/);
  }
  await assert.rejects(loadBrowserProfiles({ readFileImpl: async () => { throw Error('PRIVATE_DENIED_PATH'); } }), /^Error: Browser profile setup is invalid\.$/);
});

test('construction and capability reads never spawn or expose profile directories', async () => {
  const f = fixture();
  assert.equal(f.launcher.available('primary'), true); assert.equal(f.launcher.available('test'), true);
  assert.equal(f.launcher.available('other'), false); assert.equal(f.calls.length, 0);
  assert.deepEqual(Object.keys(f.launcher).sort(), ['available', 'open']);
  for (const options of [{ profiles: undefined }, { platform: 'linux' }, { platform: 'win32' }]) {
    const disabled = fixture(options);
    assert.equal(disabled.launcher.available('primary'), false);
    await assert.rejects(disabled.launcher.open('primary', 'request-1'), sanitized);
    assert.equal(disabled.calls.length, 0);
  }
});

test('only the fixed Chrome executable, profile argument and local account page can be launched', async () => {
  const f = fixture();
  assert.deepEqual(await f.launcher.open('primary', 'opaque-request-1'), { ok: true, state: 'opening' });
  assert.deepEqual(await f.launcher.open('test', 'opaque-request-2'), { ok: true, state: 'opening' });
  assert.deepEqual(f.calls.map(call => call.args), [
    ['--profile-directory=Profile 21', '--new-window', 'http://127.0.0.1:8795/accounts/primary'],
    ['--profile-directory=Profile 22', '--new-window', 'http://127.0.0.1:8795/accounts/test']
  ]);
  for (const call of f.calls) {
    assert.equal(call.binary, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    assert.equal(call.settings.shell, false); assert.equal(call.settings.detached, true); assert.equal(call.settings.stdio, 'ignore');
    assert.equal(call.settings.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.ok(Object.keys(call.settings.env).every(key => ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'].includes(key)));
    assert.ok(call.args.every(value => !/remote-debugging|disable-web-security|user-data-dir|opaque-request/.test(value)));
  }
  assert.ok(f.children.every(child => child.unreferenced && !child.killed));
});

test('untrusted identities, request objects, shell syntax and flags cannot become process arguments', async () => {
  const f = fixture();
  for (const id of ['unknown', '__proto__', '../primary', 'primary --new-window', null, {}]) {
    await assert.rejects(f.launcher.open(id, 'request-1'), error => error.status === 404);
  }
  for (const id of ['', 'x'.repeat(161), 'request;open', 'request\narg', 'request arg', { url: 'https://outside.example' }]) {
    await assert.rejects(f.launcher.open('primary', id), error => error.status === 400);
  }
  for (const invalid of [{ ...profiles, executable: '/bin/sh' }, { ...profiles, primary: '-Profile 21' }]) {
    assert.throws(() => createBrowserLauncher({ profiles: invalid }), /Browser profile setup is invalid/);
  }
  assert.equal(f.calls.length, 0);
  const mutable = { ...profiles }, pinned = fixture({ profiles: mutable }); mutable.primary = 'Profile 22';
  await pinned.launcher.open('primary', 'pinned-1'); assert.equal(pinned.calls[0].args[0], '--profile-directory=Profile 21');
});

test('same request and concurrent aliases coalesce per account without opening duplicate windows', async () => {
  const f = fixture({ mode: 'hold' });
  const a = f.launcher.open('primary', 'start-1'), b = f.launcher.open('primary', 'start-1'), c = f.launcher.open('primary', 'start-2');
  assert.equal(f.calls.length, 1); f.children[0].emit('spawn');
  const values = await Promise.all([a, b, c]); assert.ok(values.every(value => value.state === 'opening'));
  await f.launcher.open('primary', 'start-1'); await f.launcher.open('primary', 'start-2'); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(values).includes('Profile'), false);
});

test('distinct requests receive an explicit cooldown while cached requests stay idempotent', async () => {
  const f = fixture(); await f.launcher.open('primary', 'one'); f.advance(19999);
  await assert.rejects(f.launcher.open('primary', 'two'), error => error.status === 429 && /Wait/.test(error.message));
  await f.launcher.open('primary', 'one'); assert.equal(f.calls.length, 1);
  f.advance(1); await f.launcher.open('primary', 'two'); assert.equal(f.calls.length, 2);
  f.advance(-1000); await assert.rejects(f.launcher.open('primary', 'three'), error => error.status === 429);
  assert.equal(f.calls.length, 2);
});

test('spawn failures are sanitized, remembered and never automatically retried', async () => {
  for (const mode of ['throw', 'error']) {
    const f = fixture({ mode });
    await assert.rejects(f.launcher.open('primary', 'failed-1'), sanitized);
    await assert.rejects(f.launcher.open('primary', 'failed-1'), sanitized);
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.launcher.open('primary', 'failed-2'), error => error.status === 429);
  }
});

test('an unconfirmed spawn is bounded without killing a browser or treating it as connected', async () => {
  const f = fixture({ mode: 'hold', spawnTimeoutMs: 5 });
  await assert.rejects(f.launcher.open('primary', 'late-1'), sanitized);
  assert.equal(f.children[0].killed, false); assert.equal(f.calls.length, 1);
  f.children[0].emit('spawn'); assert.equal(f.children[0].unreferenced, true);
  await assert.rejects(f.launcher.open('primary', 'late-1'), sanitized); assert.equal(f.calls.length, 1);
});

test('an expired request record can be opened again only by a later explicit request', async () => {
  const f = fixture(); await f.launcher.open('primary', 'old-request'); f.advance(120000);
  assert.equal(f.calls.length, 1); await f.launcher.open('primary', 'old-request'); assert.equal(f.calls.length, 2);
});

test('third mapping is optional for old installations and only a distinct fixed third profile may open', async () => {
  const old = fixture(); assert.equal(old.launcher.available('third'), false);
  await assert.rejects(old.launcher.open('third', 'old-map-third'), sanitized); assert.equal(old.calls.length, 0);
  const triple = { ...profiles, third: 'Profile 23' };
  assert.deepEqual(await loadBrowserProfiles({ readFileImpl: async () => JSON.stringify(triple) }), triple);
  const f = fixture({ profiles: triple }); assert.equal(f.launcher.available('third'), true);
  await f.launcher.open('third', 'third-only');
  assert.deepEqual(f.calls[0].args, ['--profile-directory=Profile 23', '--new-window', 'http://127.0.0.1:8795/accounts/third']);
  assert.equal(f.calls[0].binary, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  for (const mapping of [{ ...triple, third: profiles.primary }, { ...triple, third: profiles.test }, { ...triple, third: '../Profile 23' }, { ...triple, fifth: 'Profile 24' }]) {
    assert.throws(() => createBrowserLauncher({ profiles: mapping }), /Browser profile setup is invalid/);
  }
});
