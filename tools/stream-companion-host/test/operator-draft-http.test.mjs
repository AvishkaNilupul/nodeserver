import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHostServer, REMOTE_PREFIX } from '../server.mjs';
import { HostStore } from '../lib/store.mjs';
import { generateOperatorDraft } from '../lib/operator-model.mjs';

const clients = ['primary', 'test', 'third', 'fourth'].map((id, i) => ({
  id, account: `fixture_${id}`, token: String(i + 1).repeat(48)
}));
const channel = 'fixture_room', viewer = 'fixture_viewer';
const remoteToken = 'synthetic-browser-pairing'.repeat(2), csrfToken = 'fixture-csrf';
const deviceQA = process.env.COMPANION_QA_DEVICE_MODEL === '1';
const draftBody = requestId => ({ requestId, action: 'draft', params: { mode: 'reply' } });

async function fixture(t, cannedReply, dispatch) {
  const now = Date.now();
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true });
  const stream = { channel, isLive: true, streamId: '111', checkedAt: now, title: 'Team finals', gameName: 'Racing' };
  const profiles = clients.map(({ id, account }) => ({
    id, account, channel, available: true, authorized: true, connected: true, checkedAt: now,
    settings: { paused: false, allowedChannel: channel }, browser: { online: true, lastSeenAt: now },
    streamContext: stream, chat: { messages: [] }, controls: { pending: null, recent: [] }
  }));
  const modelCalls = [], helperCalls = [], freshChannels = new Map();
  const server = createHostServer({ store, clients, port: 0, csrfToken, remoteToken,
    accounts: { snapshot: async options => ({ instances: structuredClone(profiles).map(profile => {
        if (options?.fresh && freshChannels.has(profile.id)) profile.channel = freshChannels.get(profile.id);
        return profile;
      }) }),
      command: async (id, body) => {
        helperCalls.push({ id, body });
        if (dispatch) return dispatch(id, body);
        return { ok: true, command: { ...body, state: 'queued' } };
      } },
    browserLauncher: { available: () => false },
    generateDraft(context, options) {
      modelCalls.push(context);
      if (deviceQA && !dispatch) return generateOperatorDraft(context, options);
      if (cannedReply) return cannedReply;
      const corrected = context.messages.find(m => m.text.startsWith('Correction:'));
      return corrected?.text.slice('Correction: '.length) || 'Which score did you mean?';
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const local = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
  const remote = { ...local, Authorization: `Bearer ${remoteToken}` };
  async function request(path, headers, body) {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function observe(client, messages) {
    store.sync(client.id, { channel, connected: true, ready: false });
    const paired = { Authorization: `Bearer ${client.token}`, 'X-Companion-Id': client.id };
    const result = await request('/internal/director/observe', paired, { protocol: 1, armed: false,
      binding: { generation: 'fixture-generation', sessionId: 'fixture-session', settingsRevision: 1 },
      streamContext: stream, messages,
      restrictions: { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false } });
    assert.equal(result.status, 200);
  }
  const row = (id, author, text, age) => ({ id, author, text, at: now - age, channel });
  function assertDeliveryState(historyRows = 0, expectedCommands = []) {
    assert.deepEqual(helperCalls, expectedCommands);
    for (const table of ['director_plans', 'host_proposals', 'host_permits', 'contributions']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    }
    assert.equal(store.director.history().history.length, historyRows);
  }
  return { store, profiles, request, local, remote, row, observe, modelCalls, assertDeliveryState, freshChannels };
}

test('local and paired account pages draft corrected scores and dispatch only an explicit, still-current edited send', async t => {
  const f = await fixture(t);
  for (const [i, client] of clients.entries()) {
    const profile = f.profiles[i], score = 14 + i, id = `score-${client.id}`;
    const facts = f.row('scores', viewer, 'Amber finished with 8 points and Teal finished with 11 points.', 24_000);
    const correction = f.row('correction', viewer, `Correction: Teal finished with ${score} points.`, 4000);
    const target = f.row('question', viewer, 'So what was Teal’s final score?', 3000);
    const other = f.row('other', 'different_fan', 'Who won the fishing event?', 1000);
    f.store.director.writeHistory({ clientId: client.id, account: client.account, channel, streamId: '111', kind: 'conversation',
      attemptId: 'earlier-' + client.id, messageId: 'confirmed', at: facts.at + 1000,
      text: 'The original score for Teal was 11 points.', delivery: 'confirmed', submitted: true, source: 'manual' });
    // Older helper status exposes the four rows but only the paired observation carries native parent IDs.
    profile.chat.messages = [facts, correction, target, other];
    await f.observe(client, [facts, { ...correction, replyParentId: 'confirmed' }, { ...target, replyParentId: 'correction' }, other]);
    const prefix = i % 2 ? REMOTE_PREFIX : '', headers = i % 2 ? f.remote : f.local;
    const statusPath = prefix + '/api/accounts';
    const initial = await f.request(statusPath, headers);
    assert.equal(initial.status, 200);
    assert.equal(f.modelCalls.length, i);
    const posted = await f.request(prefix + `/api/accounts/${client.id}/command`,
      { ...headers, 'X-CSRF-Token': initial.data.csrfToken }, draftBody(id));
    assert.equal(posted.status, 200);
    assert.equal(posted.data.command.state, 'running');
    const deadline = Date.now() + (deviceQA ? 32_000 : 2000);
    let command;
    do {
      const polled = await f.request(statusPath, headers);
      assert.equal(polled.status, 200);
      const owner = polled.data.instances.find(p => p.id === client.id);
      assert.ok(polled.data.instances.filter(p => p !== owner).every(p => !p.controls.recent.some(c => c.requestId === id)));
      command = owner.controls.recent.find(c => c.requestId === id);
      assert.ok(command);
      if (command.state !== 'running') break;
      await sleep(deviceQA ? 80 : 10);
    } while (Date.now() < deadline);
    assert.equal(command.state, 'completed', command.error);
    assert.equal(command.result.targetAuthor, viewer);
    assert.equal(command.result.account, client.account);
    assert.match(command.result.text, new RegExp(`\\b${score}\\b`));
    assert.doesNotMatch(command.result.text, /\b(?:8|11)\b/);
    assert.deepEqual(f.modelCalls[i], { account: client.account, channel,
      target: { author: viewer, text: target.text }, stream: { title: 'Team finals', category: 'Racing' },
      messages: [{ author: viewer, text: facts.text }, { author: client.account, text: 'The original score for Teal was 11 points.' },
        { author: viewer, text: correction.text }] });
    if (deviceQA) t.diagnostic(`${client.id}: ${command.result.text}`);
  }
  assert.equal(f.modelCalls.length, 4);
  // The account page still shows the old channel. A forced snapshot learns
  // that the helper switched rooms while the operator was editing the draft.
  f.freshChannels.set('test', 'different_room');
  const cached = await f.request(REMOTE_PREFIX + '/api/accounts', f.remote);
  const previouslyReady = cached.data.instances.find(p => p.id === 'test').controls.recent.find(c => c.requestId === 'score-test');
  assert.equal(previouslyReady.state, 'completed');
  const send = await f.request(REMOTE_PREFIX + '/api/accounts/test/command', { ...f.remote, 'X-CSRF-Token': csrfToken },
    { requestId: 'review-send:fixture:score-test', action: 'send', params: { text: 'My edited reply.' } });
  assert.equal(send.status, 409);
  assert.equal(send.data.code, 'review_expired');
  f.assertDeliveryState(4);
  const edited = { requestId: 'review-send:fixture:score-third', action: 'send', params: { text: 'That puts Teal on 16.' } };
  const approved = await f.request('/api/accounts/third/command', { ...f.local, 'X-CSRF-Token': csrfToken }, edited);
  assert.equal(approved.status, 200);
  assert.equal(approved.data.command.state, 'queued');
  f.assertDeliveryState(4, [{ id: 'third', body: edited }]);
});

test('phone and desktop using the same draft can dispatch only one reviewed send', async t => {
  let beginDispatch, release;
  const started = new Promise(resolve => { beginDispatch = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, 'Blue leads.', async (_id, body) => {
    beginDispatch(); await held;
    return { ok: true, command: { ...body, state: 'queued' } };
  });
  f.profiles[0].chat.messages = [f.row('question', viewer, 'Who leads?', 500)];
  const headers = { ...f.local, 'X-CSRF-Token': csrfToken }, path = '/api/accounts/primary/command';
  const created = await f.request(path, headers, draftBody('one-draft'));
  assert.equal(created.status, 200);
  let ready = false;
  for (let i = 0; i < 160; i++) {
    const snapshot = await f.request('/api/accounts', f.local);
    if (snapshot.data.instances[0].controls.recent.some(c => c.requestId === 'one-draft' && c.result?.text)) { ready = true; break; }
    await sleep(50);
  }
  assert.ok(ready);
  const desktop = { action: 'send', requestId: 'review-send:desktop:one-draft', params: { text: 'The blue side leads.' } };
  const phone = { ...desktop, requestId: 'review-send:phone:one-draft', params: { text: 'Blue is ahead.' } };
  const first = f.request(path, headers, desktop);
  await started;
  const competing = f.request(REMOTE_PREFIX + path, { ...f.remote, 'X-CSRF-Token': csrfToken }, phone);
  const repeat = f.request(path, headers, desktop);
  release();
  const [accepted, duplicate, same] = await Promise.all([first, competing, repeat]);
  assert.equal(accepted.status, 200); assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.code, 'review_used'); assert.deepEqual(same.data, accepted.data);
  const edited = await f.request(path, headers, { ...desktop, params: { text: 'A different edit.' } });
  assert.equal(edited.status, 409);
  const current = await f.request('/api/accounts', f.local);
  const draft = current.data.instances[0].controls.recent.find(c => c.requestId === 'one-draft');
  assert.equal(draft.state, 'cancelled'); assert.equal(draft.result, undefined);
  f.assertDeliveryState(0, [{ id: 'primary', body: desktop }]);
});

test('losing the helper acknowledgement never hands a reviewed send to the helper twice', async t => {
  const f = await fixture(t, 'Blue leads.', () => { throw Object.assign(Error('Lost acknowledgement'), { status: 503 }); });
  f.profiles[0].chat.messages = [f.row('question', viewer, 'Who leads?', 500)];
  const path = '/api/accounts/primary/command', headers = { ...f.local, 'X-CSRF-Token': csrfToken };
  assert.equal((await f.request(path, headers, draftBody('lost-ack'))).status, 200);
  const polled = await f.request('/api/accounts', f.local);
  assert.equal(polled.data.instances[0].controls.recent.find(c => c.requestId === 'lost-ack').state, 'completed');
  const command = { requestId: 'review-send:desktop:lost-ack', action: 'send', params: { text: 'Blue leads.' } };
  assert.equal((await f.request(path, headers, command)).status, 503);
  assert.equal((await f.request(path, headers, command)).status, 503);
  const duplicate = await f.request(path, headers, { ...command, requestId: 'review-send:phone:lost-ack' });
  assert.equal(duplicate.data.code, 'review_used');
  f.assertDeliveryState(0, [{ id: 'primary', body: command }]);
});

test('the reviewed route answers a viewer asking for advice and leaves passing commentary alone', async t => {
  const f = await fixture(t, 'I’d take Willow first. The wide turns give you room to learn.');
  const client = clients[0], profile = f.profiles[0];
  const facts = f.row('routes', viewer, 'Willow has two wide turns and no jumps. Flint saves three seconds but has a blind jump.', 4000);
  const question = f.row('advice', viewer, 'For my first run which route would you try and why?', 2000);
  const aside = f.row('aside', 'another_fan', 'Both of those guys are kind of jerks.', 1000);
  profile.chat.messages = [facts, question, aside];
  const headers = { ...f.local, 'X-CSRF-Token': csrfToken };
  const path = '/api/accounts/primary/command';
  const submitted = await f.request(path, headers, draftBody('advice-draft'));
  assert.equal(submitted.status, 200);
  let command;
  const deadline = Date.now() + (deviceQA ? 32_000 : 2000);
  do {
    const snapshot = await f.request('/api/accounts', f.local);
    command = snapshot.data.instances[0].controls.recent.find(c => c.requestId === 'advice-draft');
    if (command?.state !== 'running') break;
    await sleep(40);
  } while (Date.now() < deadline);
  assert.equal(command.state, 'completed');
  assert.equal(command.result.targetAuthor, viewer);
  // A viewer can identify Willow by its wide turns even if the reply omits its name.
  assert.match(command.result.text, /willow|wide (?:turns?|corners?)|no jumps?/i);
  assert.match(command.result.text, /wide|turn|jump|safer|easier/i);
  assert.doesNotMatch(command.result.text, /the (?:message|viewer)|acknowledged|no factual claim/i);
  assert.doesNotMatch(command.result.text, /willow(?:(?!flint).){0,60}(?:saves? (?:three|3) seconds|is (?:faster|the shortcut))/i);
  assert.deepEqual(f.modelCalls[0].messages, [{ author: viewer, text: facts.text }]);
  if (deviceQA) t.diagnostic(command.result.text);
  profile.chat.messages = [aside];
  const quiet = await f.request(path, headers, draftBody('quiet'));
  assert.equal(quiet.status, 409); assert.equal(quiet.data.code, 'no_conversation');
  assert.equal(f.modelCalls.length, 1); f.assertDeliveryState();
});

test('matching native observation identity is required to project parent and bot tags', async t => {
  const f = await fixture(t), client = clients[0], profile = f.profiles[0];
  const rows = ['match', 'wrong-author', 'wrong-time', 'wrong-room'].map(id => f.row(id, viewer, 'Where was the finish?', 1000));
  profile.chat.messages = rows.map(row => ({ ...row, channel: row.id === 'wrong-room' ? 'elsewhere' : channel }));
  await f.observe(client, rows.map(row => ({ ...row, replyParentId: 'observed-parent', isBot: true,
    author: row.id === 'wrong-author' ? 'another_fan' : row.author, at: row.at + Number(row.id === 'wrong-time') })));
  const result = await f.request(REMOTE_PREFIX + '/api/accounts', f.remote);
  assert.equal(result.status, 200);
  const projected = result.data.instances.find(p => p.id === client.id).chat.messages;
  assert.deepEqual(projected[0], { ...rows[0], replyParentId: 'observed-parent', isBot: true });
  assert.deepEqual(projected.slice(1), profile.chat.messages.slice(1));
  assert.deepEqual(f.modelCalls, []);
  f.assertDeliveryState();
});

test('draft POST enforces local CSRF, remote pairing and an eligible viewer before invoking the model', async t => {
  const f = await fixture(t), path = '/api/accounts/test/command', input = draftBody('forbidden');
  f.profiles[1].chat.messages = [...clients.map(({ account }) => f.row(account, account, 'What was the score?', 2000)),
    f.row('bot', 'nightbot', 'Chat reminder', 1000)];
  for (const [prefix, headers] of [['', f.local], [REMOTE_PREFIX, { ...f.local, 'X-CSRF-Token': csrfToken }],
    [REMOTE_PREFIX, f.remote], ['', { ...f.local, Origin: 'https://outside.invalid', 'X-CSRF-Token': csrfToken }]]) {
    assert.equal((await f.request(prefix + path, headers, input)).status, 403);
  }
  const issue = await f.request(REMOTE_PREFIX + path, { ...f.remote, 'X-CSRF-Token': csrfToken }, input);
  assert.equal(issue.status, 409);
  assert.match(issue.data.error, /no recent viewer/i);
  assert.deepEqual(f.modelCalls, []);
  f.assertDeliveryState();
});
