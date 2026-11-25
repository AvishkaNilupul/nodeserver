import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClipsController, createClipsView, renderClips, clipUrl, clipAuthorizationUrl } from '../public/clips.js';

const at = Date.parse('2026-11-25T08:00:00Z'), csrf = 'a'.repeat(43);
const account = (id = 'primary', extra = {}) => ({ id, account: id === 'primary' ? 'main_account' : 'second_account', available: true, authorized: true, canAuthorize: true, error: '', ...extra });
const snapshot = extra => ({ ok: true, updatedAt: new Date(at).toISOString(), csrfToken: csrf, settings: { enabled: false, channel: 'aviskarex', accountIds: ['primary'] }, accounts: [account(), account('test')], jobs: [], detector: { state: 'held', reason: 'Coordination paused.' }, ...extra });
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ data = snapshot(), now = () => at, post = () => reply({ ok: true }), basePath = '', onState = () => {} } = {}) {
  const calls = [], timeouts = new Map(), intervals = new Map(); let key = 0;
  const c = createClipsController({ now, basePath, onState, requestId: () => 'clip-request-1',
    fetchImpl: async (path, options) => { calls.push({ path, options, body: options.body && JSON.parse(options.body) }); return options.method === 'GET' ? reply(data) : post(path, options); },
    setTimeoutImpl: (fn, ms) => { const id = ++key; timeouts.set(id, { fn, ms }); return id; }, clearTimeoutImpl: id => timeouts.delete(id),
    setIntervalImpl: (fn, ms) => { const id = ++key; intervals.set(id, { fn, ms }); return id; }, clearIntervalImpl: id => intervals.delete(id) });
  return { c, calls, timeouts, intervals, data };
}
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.hidden = false; this.value = ''; this.checked = false; }
  set innerHTML(_) { throw Error('Dynamic HTML is forbidden'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
function view() { const nodes = new Map(); return createClipsView({ getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) }); }
const descend = node => [node, ...node.children.flatMap(descend)];
const draw = (v, c) => renderClips(v, c.getState(), { now: at, canMutate: c.canMutate, canCreate: c.canCreate, canAuthorize: c.canAuthorize });

test('clips panel is separate from hidden account views and uses external responsive assets', async () => {
  const html = await readFile(new URL('../public/account.html', import.meta.url), 'utf8'), css = await readFile(new URL('../public/clips.css', import.meta.url), 'utf8');
  assert.match(html, /src="__COMPANION_BASE__\/clips.js"/); assert.match(html, /href="__COMPANION_BASE__\/clips.css"/);
  assert.ok(html.indexOf('data-clips-app') > html.indexOf('id="command-history"'));
  assert.ok(!/<script(?![^>]*\bsrc=)|\son\w+=|\sstyle=/.test(html));
  for (const id of Object.keys(view().nodes)) assert.ok(html.includes(`id="${id}"`), `${id} exists`);
  assert.match(css, /font-size:16px/); assert.match(css, /max-width:700px/); assert.match(html, /not events inside the video/);
});

test('load, polling, restoration and selection only perform reads', async () => {
  const f = fixture(); f.c.start(); await flush(); await f.c.refresh();
  f.c.edit('enabled', true); f.c.edit('selection', 'both'); f.c.edit('channel', 'some_channel');
  for (const timer of f.intervals.values()) timer.fn(); await flush();
  f.c.stop(); f.c.start(); await flush();
  assert.ok(f.calls.length >= 3); assert.ok(f.calls.every(call => call.options.method === 'GET'));
  f.c.stop(); assert.equal(f.intervals.size, 0);
});

test('manual creation posts exact one-creator selection once on remote mount with current CSRF', async () => {
  const f = fixture({ basePath: '/admin/stream-companion', post: () => reply({ ok: true, job: { state: 'queued' } }) });
  await f.c.refresh(); f.c.edit('selection', 'both'); assert.equal(await f.c.create(), true);
  const writes = f.calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/admin/stream-companion/api/clips/create');
  assert.deepEqual(writes[0].body, { requestId: 'clip-request-1', channel: 'aviskarex', accountIds: ['primary', 'test'] });
  assert.equal(writes[0].options.headers['X-CSRF-Token'], csrf); assert.equal(writes[0].options.redirect, 'error');
  assert.match(f.c.getState().feedback, /recorded/);
});

test('edited fields survive polling; save is explicit and includes enabled/channel/accounts only', async () => {
  const f = fixture(); await f.c.refresh(); f.c.edit('channel', 'OTHER_CHANNEL'); f.c.edit('selection', 'test'); f.c.edit('enabled', true);
  await f.c.refresh(); assert.equal(f.c.getState().form.channel, 'other_channel'); assert.equal(f.c.getState().form.selection, 'test');
  assert.equal(await f.c.save(), true); const write = f.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(write.body, { enabled: true, channel: 'other_channel', accountIds: ['test'] });
  assert.equal(f.c.getState().form.dirty, false);
});

test('stale receipt, stale server snapshot, missing CSRF and absent scope block creation and grants', async () => {
  let time = at; const f = fixture({ now: () => time, data: snapshot({ accounts: [account('primary', { authorized: false })] }) });
  await f.c.refresh(); assert.equal(f.c.canCreate(), false); assert.equal(f.c.canAuthorize('primary'), true);
  time += 16000; assert.equal(f.c.canAuthorize('primary'), false); assert.equal(await f.c.create(), false); assert.equal(await f.c.authorize('primary'), false);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
  const stale = fixture({ data: snapshot({ updatedAt: new Date(at - 21000).toISOString() }) }); await stale.c.refresh(); assert.equal(stale.c.canMutate(), false); assert.equal(stale.c.getState().network, 'stale');
  const noCsrf = fixture({ data: snapshot({ csrfToken: '' }) }); await noCsrf.c.refresh(); assert.equal(noCsrf.c.canMutate(), false);
});

test('Enable clips strictly requires backend held permission and never clicks Twitch approval', async () => {
  const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false, canAuthorize: false }), account('test', { authorized: false })] }),
    post: () => reply({ ok: true, pending: true, verificationUrl: 'https://www.twitch.tv/activate', userCode: 'ABCD-EFGH', pollAfterMs: 7000 }) });
  await f.c.refresh(); assert.equal(await f.c.authorize('primary'), false); assert.equal(await f.c.authorize('test'), true);
  const writes = f.calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { accountId: 'test', action: 'start' });
  assert.equal(f.timeouts.size, 1); assert.equal([...f.timeouts.values()][0].ms, 7000);
  const v = view(); draw(v, f.c); const links = descend(v.nodes['clips-auth-test']).filter(node => node.tagName === 'a');
  assert.equal(links.length, 1); assert.equal(links[0].href, 'https://www.twitch.tv/activate'); assert.equal(links[0].rel, 'noopener noreferrer');
  assert.match(v.nodes['clips-auth-test'].textContent, /ABCD-EFGH/); f.c.stop(); assert.equal(f.timeouts.size, 0);
});

test('authorization pending ACK without code continues polling until public details and grant arrive', async () => {
  let n = 0; const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false })] }), post: () => reply(++n === 1 ? { ok: true, pending: true, pollAfterMs: 5000 }
    : n === 2 ? { ok: true, pending: true, verificationUrl: 'https://www.twitch.tv/activate', userCode: 'ABCD', pollAfterMs: 5000 } : { ok: true, authorized: true }) });
  await f.c.refresh(); assert.equal(await f.c.authorize('primary'), true); const v = view(); draw(v, f.c); assert.match(v.nodes['clips-auth-primary'].textContent, /Preparing Twitch/);
  [...f.timeouts.values()][0].fn(); await flush(); assert.equal(f.c.getState().authorizations.primary.userCode, 'ABCD');
  [...f.timeouts.values()].at(-1).fn(); await flush(); assert.equal(f.c.getState().authorizations.primary.authorized, true);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 3); assert.ok(f.calls.filter(call => call.options.method === 'POST').every(call => call.path.endsWith('/authorization')));
  f.c.stop();
});

test('uncertain create never retries on refresh or restoration and does not claim success', async () => {
  const f = fixture({ post: () => { throw Error('secret transport diagnostic'); } }); await f.c.refresh(); assert.equal(await f.c.create(), false);
  await f.c.refresh(); f.c.stop(); f.c.start(); await flush();
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1); assert.match(f.c.getState().error, /unconfirmed/);
  assert.ok(!f.c.getState().error.includes('secret')); assert.equal(f.c.getState().feedback, ''); f.c.stop();
});

test('unconfirmed auth POST stops automatic polling and leaves manual approval check available', async () => {
  let n = 0; const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false })] }), post: () => ++n === 1 ? reply({ ok: true, pending: true, userCode: 'CODE', verificationUrl: 'https://www.twitch.tv/activate' }) : reply({}, 503) });
  await f.c.refresh(); await f.c.authorize('primary'); const timer = [...f.timeouts.values()][0]; f.timeouts.clear(); timer.fn(); await flush();
  assert.equal(f.timeouts.size, 0); assert.equal(f.c.getState().authorizations.primary.pending, true); assert.match(f.c.getState().authorizations.primary.error, /Check approval/);
  const v = view(); draw(v, f.c); assert.equal(v.nodes['clips-check-primary'].hidden, false); f.c.stop();
});

test('hostile values render as text and only confirmed canonical Twitch clip links become clickable', async () => {
  const hostile = '<img src=x onerror=steal()>', f = fixture({ data: snapshot({ accounts: [account('primary', { account: hostile })], jobs: [
    { channel: hostile, account: hostile, source: 'automatic', reason: hostile, error: hostile, state: 'unknown', url: 'https://clips.twitch.tv/Unconfirmed', createdAt: at },
    { channel: 'aviskarex', state: 'confirmed', url: 'javascript:alert(1)', createdAt: at },
    { channel: 'aviskarex', state: 'confirmed', url: 'https://clips.twitch.tv/Valid_ID-1', createdAt: at }
  ], unexpectedSecret: 'must-not-render' }) });
  await f.c.refresh(); const v = view(); draw(v, f.c);
  assert.match(v.nodes['clips-history'].textContent, /<img/); assert.match(v.nodes['clips-history'].textContent, /Chat reaction detected/); assert.match(v.nodes['clips-history'].textContent, /Unconfirmed/);
  const links = descend(v.nodes['clips-history']).filter(node => node.tagName === 'a'); assert.equal(links.length, 1); assert.equal(links[0].href, 'https://clips.twitch.tv/Valid_ID-1');
  assert.ok(!Object.values(v.nodes).some(node => node.textContent.includes('must-not-render') || node.textContent.includes(csrf)));
});

test('URL validators reject credentials, misleading origins, extra query and noncanonical paths', () => {
  for (const url of ['javascript:alert(1)', 'https://clips.twitch.tv.evil/a', 'http://clips.twitch.tv/a', 'https://u@clips.twitch.tv/a', 'https://clips.twitch.tv/a?x=y', 'https://clips.twitch.tv/a/b']) assert.equal(clipUrl(url), '');
  for (const url of ['https://twitch.tv/activate', 'https://www.twitch.tv/activate?x=y', 'https://www.twitch.tv/activate/evil', 'https://www.twitch.tv.evil/activate']) assert.equal(clipAuthorizationUrl(url), '');
});

test('status failures retain last values, disable controls and keep diagnostics out of UI', async () => {
  let fail = false; const c = createClipsController({ now: () => at, fetchImpl: async () => { if (fail) throw Error('private credential'); return reply(snapshot()); } });
  await c.refresh(); fail = true; await c.refresh(); const v = view(); renderClips(v, c.getState(), { canMutate: c.canMutate, canCreate: c.canCreate });
  assert.equal(c.canMutate(), false); assert.equal(v.nodes['clips-create'].disabled, true); assert.match(v.nodes['clips-error'].textContent, /unavailable/); assert.ok(!v.nodes['clips-error'].textContent.includes('credential'));
});


test('expired authorization after page restoration unlocks a new code without replaying the old grant', async () => {
  let time = at; const f = fixture({ now: () => time, data: snapshot({ accounts: [account('primary', { authorized: false })] }),
    post: () => reply({ ok: true, pending: true, verificationUrl: 'https://www.twitch.tv/activate', userCode: 'ABCD', expiresAt: at + 10000 }) });
  await f.c.refresh(); await f.c.authorize('primary'); f.c.stop(); time += 11000; f.data.updatedAt = new Date(time).toISOString();
  f.c.start(); await flush(); assert.equal(f.c.getState().authorizations.primary.pending, false); assert.equal(f.c.canAuthorize('primary'), true);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1); f.c.stop();
});


test('definitive denied, failed or cancelled authorization releases the old code for an explicit new attempt', async () => {
  for (const error of ['Twitch authorization was denied.', 'Twitch device authorization failed.', 'Clip authorization was cancelled.']) {
    let n = 0; const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false })] }),
      post: () => ++n === 2 ? reply({ ok: false, error }, 409) : reply({ ok: true, pending: true, verificationUrl: 'https://www.twitch.tv/activate', userCode: n === 1 ? 'OLD-CODE' : 'NEW-CODE' }) });
    await f.c.refresh(); assert.equal(await f.c.authorize('primary'), true);
    const timer = [...f.timeouts.values()][0]; f.timeouts.clear(); timer.fn(); await flush();
    assert.equal(f.c.getState().authorizations.primary.pending, false); assert.equal(f.timeouts.size, 0);
    const v = view(); draw(v, f.c); assert.equal(v.nodes['clips-enable-primary'].disabled, false); assert.equal(v.nodes['clips-check-primary'].hidden, true);
    assert.ok(!v.nodes['clips-auth-primary'].textContent.includes('OLD-CODE')); assert.match(v.nodes['clips-auth-primary'].textContent, /new code/);
    assert.equal(await f.c.authorize('primary'), true);
    const writes = f.calls.filter(call => call.options.method === 'POST'); assert.deepEqual(writes.map(call => call.body.action), ['start', 'poll', 'start']);
    assert.equal(f.c.getState().authorizations.primary.userCode, 'NEW-CODE'); f.c.stop();
  }
});

test('a definitive authorization start failure is shown without a pending lock even when its body is unreadable', async () => {
  const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false })] }),
    post: () => ({ ok: false, status: 409, json: async () => { throw Error('Unreadable diagnostic'); } }) });
  await f.c.refresh(); assert.equal(await f.c.authorize('primary'), false);
  assert.equal(f.c.getState().authorizations.primary.pending, false); assert.equal(f.timeouts.size, 0);
  const v = view(); draw(v, f.c); assert.equal(v.nodes['clips-enable-primary'].disabled, false); assert.equal(v.nodes['clips-check-primary'].hidden, true);
  assert.match(f.c.getState().error, /not accepted/); assert.ok(!f.c.getState().error.includes('Unreadable'));
});

test('all seven finite clip creator subsets save and create with exact account identities', async () => {
  const choices = { primary: ['primary'], test: ['test'], third: ['third'], both: ['primary', 'test'],
    'primary-third': ['primary', 'third'], 'test-third': ['test', 'third'], all: ['primary', 'test', 'third'] };
  for (const [selection, accountIds] of Object.entries(choices)) {
    const f = fixture({ data: snapshot({ accounts: [account(), account('test'), account('third', { account: 'third_account' })] }) });
    await f.c.refresh(); f.c.edit('selection', selection);
    assert.equal(await f.c.save(), true); assert.equal(await f.c.create(), true);
    const posts = f.calls.filter(call => call.options.method === 'POST');
    assert.equal(posts.length, 2); assert.deepEqual(posts[0].body.accountIds, accountIds);
    assert.deepEqual(posts[1].body.accountIds, accountIds); assert.ok(posts[1].path.endsWith('/api/clips/create'));
    f.c.stop();
  }
});

test('saved third pairs roundtrip without silently becoming the original two accounts', async () => {
  for (const [accountIds, selection, label] of [
    [['primary', 'third'], 'primary-third', 'Main + third'], [['third', 'test'], 'test-third', 'Second + third'],
    [['primary', 'test'], 'both', 'Main + second'], [['primary', 'test', 'third'], 'all', 'All three']
  ]) {
    const f = fixture({ data: snapshot({ settings: { enabled: true, channel: 'aviskarex', accountIds }, accounts: [account(), account('test'), account('third')] }) });
    await f.c.refresh(); assert.equal(f.c.getState().form.selection, selection);
    const v = view(); draw(v, f.c); assert.match(v.nodes['clips-saved'].textContent, new RegExp(label.replace('+', '\\+')));
    assert.equal(await f.c.save(), true);
    assert.deepEqual(new Set(f.calls.find(call => call.options.method === 'POST').body.accountIds), new Set(accountIds));
    f.c.stop();
  }
});

test('third permission and clip history stay bound to the third account', async () => {
  const data = snapshot({ accounts: [account(), account('test'), account('third', { account: 'third_account', authorized: false })],
    jobs: [{ requestId: 'third-clip', accountId: 'third', channel: 'aviskarex', source: 'manual', createdAt: at, state: 'confirmed', url: 'https://clips.twitch.tv/ThirdClip' }] });
  const f = fixture({ data, post: () => reply({ ok: true, pending: true, userCode: 'THIRD777', verificationUrl: 'https://www.twitch.tv/activate', pollAfterMs: 5000 }) });
  await f.c.refresh(); const v = view(); draw(v, f.c);
  assert.equal(v.nodes['clips-name-third'].textContent, '@third_account'); assert.equal(v.nodes['clips-enable-third'].disabled, false);
  assert.match(v.nodes['clips-history'].textContent, /Third account/);
  assert.equal(await f.c.authorize('third'), true);
  const writes = f.calls.filter(call => call.options.method === 'POST'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { accountId: 'third', action: 'start' });
  draw(v, f.c); assert.match(v.nodes['clips-auth-third'].textContent, /third_account/); assert.match(v.nodes['clips-auth-third'].textContent, /THIRD777/);
  assert.equal(v.nodes['clips-auth-primary'].textContent, ''); assert.equal(v.nodes['clips-auth-test'].textContent, '');
  f.c.stop();
});

test('Twitch activation accepts only the fixed page and unique public/device-code parameters', () => {
  const base = 'https://www.twitch.tv/activate', code = 'ABCD1234';
  for (const value of [base, `${base}?public=true`, `${base}?device-code=${code}`, `${base}?public=true&device-code=${code}`, `${base}?device-code=${code}&public=true`]) {
    assert.equal(clipAuthorizationUrl(value, code), value);
  }
  for (const value of [
    `${base}?public=false`, `${base}?public=`, `${base}?public=true&public=true`, `${base}?device-code=${code}&device-code=${code}`,
    `${base}?%64evice-code=${code}&device-code=${code}`, `${base}?device-code=ABC`, `${base}?device-code=${'A'.repeat(33)}`,
    `${base}?device-code=ABCD%26redirect%3Dhttps%3A%2F%2Fevil.example`, `${base}?device-code=https%3A%2F%2Fevil.example`,
    `${base}?device-code=${code}&redirect_uri=https%3A%2F%2Fevil.example`, `${base}?device-code=${code}&public=true&scope=anything`,
    `${base}?device-code=${code}#`, `${base}?device-code=${code}#fragment`, 'https://www.twitch.tv:443/activate',
    'https://user@www.twitch.tv/activate', 'https://www.twitch.tv.evil/activate', 'https://evil.example@www.twitch.tv/activate',
    'https://www.twitch.tv/%61ctivate?device-code=ABCD1234', 'https://%77ww.twitch.tv/activate?device-code=ABCD1234',
    'https://www.twitch.tv/activate%3Fdevice-code%3DABCD1234', 'https://www.twitch.tv/activate?device-code=%252F%252Fevil'
  ]) assert.equal(clipAuthorizationUrl(value, code), '', value);
  assert.equal(clipAuthorizationUrl(`${base}?device-code=${code}`, 'OTHER123'), '');
  assert.equal(clipAuthorizationUrl(`${base}?device-code=${code}`), `${base}?device-code=${code}`);
});

test('prefilled Twitch activation is verified against the displayed user code during authorization and rendering', async () => {
  const code = 'CODE1234', verificationUrl = `https://www.twitch.tv/activate?public=true&device-code=${code}`;
  const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false })] }),
    post: () => reply({ ok: true, pending: true, verificationUrl, userCode: code, pollAfterMs: 5000 }) });
  await f.c.refresh(); assert.equal(await f.c.authorize('primary'), true);
  const v = view(); draw(v, f.c);
  assert.equal(f.c.getState().authorizations.primary.verificationUrl, verificationUrl);
  assert.match(v.nodes['clips-auth-primary'].textContent, /CODE1234/);
  assert.deepEqual(descend(v.nodes['clips-auth-primary']).filter(node => node.tagName === 'a').map(node => node.href), [verificationUrl]);
  f.c.getState().authorizations.primary.userCode = 'DIFFERENT'; draw(v, f.c);
  assert.equal(descend(v.nodes['clips-auth-primary']).filter(node => node.tagName === 'a').length, 0);
  f.c.stop();
});

test('a malformed or mismatched fresh activation URL never falls back to an earlier approval link', async () => {
  const base = 'https://www.twitch.tv/activate';
  for (const bad of [`${base}?device-code=WRONG123`, `${base}?device-code=OLDCODE&redirect=https://evil.example`]) {
    let calls = 0;
    const f = fixture({ data: snapshot({ accounts: [account('primary', { authorized: false })] }), post: () => reply({ ok: true, pending: true,
      verificationUrl: ++calls === 1 ? `${base}?device-code=OLDCODE` : bad, userCode: 'OLDCODE', pollAfterMs: 5000 }) });
    await f.c.refresh(); assert.equal(await f.c.authorize('primary'), true);
    assert.equal(await f.c.authorize('primary', 'poll'), false);
    const auth = f.c.getState().authorizations.primary; assert.equal(auth.pending, false); assert.equal(auth.verificationUrl, undefined);
    const v = view(); draw(v, f.c); assert.equal(descend(v.nodes['clips-auth-primary']).filter(node => node.tagName === 'a').length, 0);
    assert.equal(f.c.canAuthorize('primary'), true); f.c.stop();
  }
});
