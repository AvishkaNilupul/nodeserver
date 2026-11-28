import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createOperatorDrafts } from '../lib/operator-drafts.mjs';

const start = Date.UTC(2026, 10, 28, 12);
const channel = 'rallyroom';
const ids = ['primary', 'test', 'third', 'fourth'];
const logins = ['mainhost', 'secondhost', 'thirdhost', 'fourthhost'];
const body = (requestId = 'draft-1') => ({ requestId, action: 'draft', params: { mode: 'reply' } });
const msg = (id, author, text, age = 0, fields = {}) => ({ id, author, text, channel, at: start - age, ...fields });
function fixture(t, options = {}) {
  let time = start;
  const instances = ids.map((id, index) => ({
    id, account: logins[index], channel, available: true, connected: true, authorized: true, checkedAt: new Date(start).toISOString(),
    settings: { paused: false, allowedChannel: channel, replySource: 'local' },
    browser: { online: true, lastSeenAt: new Date(start).toISOString() }, controls: { pending: null, recent: [] },
    streamContext: { isLive: true, channel, streamId: '123', checkedAt: start, title: 'Night rally', gameName: 'Racing' },
    chat: { messages: [msg('first', 'viewerone', 'Was the left turn tighter?')] }, sent: []
  }));
  const calls = [], contexts = [];
  const generate = (context, { signal }) => {
    contexts.push(context);
    return new Promise((resolve, reject) => calls.push({ resolve, reject, signal }));
  };
  const service = createOperatorDrafts({ snapshot: async () => ({ instances }), generate, now: () => time, companionLogins: logins, ...options });
  t.after(() => service.stop());
  return { service, instances, account: instances[0], calls, contexts, advance: delta => { time += delta; },
    status: (id = 'draft-1', instance = instances[0]) => service.decorate(instance).controls.recent.find(c => c.requestId === id) };
}

test('all four accounts receive independent review jobs and only the confirmed native parent reaches the model', async t => {
  const f = fixture(t);
  for (const account of f.instances) {
    account.chat.messages = [
      msg('old', 'viewerone', 'Did the left turn tighten?', 20_000),
      msg('related', 'viewerone', 'So brake before the crest?', 4000, { replyParentId: 'own' }),
      msg('crowd', 'otherperson', 'Loved the livery', 3000),
      msg('friend', logins[(ids.indexOf(account.id) + 1) % 4], 'Trying the hard tyres?', 2500),
      msg('bot', 'modaccount', 'Time to redeem rewards', 2000, { isBot: true }),
      msg('wrong', 'viewerthree', 'How many laps?', 0, { channel: 'elsewhere' })
    ];
    account.sent = [{ ...msg('ignored', account.account, 'Brake near the red post.', 10_000), messageId: 'own', account: account.account, delivery: 'confirmed' }];
    const { command } = await f.service.request(account.id, body());
    assert.equal(command.state, 'running');
    assert.equal(f.service.decorate(account).controls.pending.requestId, command.requestId);
  }
  for (let i = 0; i < ids.length; i++) {
    assert.deepEqual(f.contexts[i], {
      account: logins[i], channel, target: { author: 'viewerone', text: 'So brake before the crest?' },
      messages: [{ author: 'viewerone', text: 'Did the left turn tighten?' }, { author: logins[i], text: 'Brake near the red post.' }], stream: { title: 'Night rally', category: 'Racing' }
    });
    f.calls[i].resolve('Yeah, just before the red post.');
  }
  await nextTurn();
  for (const account of f.instances) {
    assert.deepEqual(f.status('draft-1', account).result, { text: 'Yeah, just before the red post.', reason: 'Draft reply to @viewerone.',
      account: account.account, channel, targetAuthor: 'viewerone', streamId: '123',
      target: { id: 'related', author: 'viewerone', text: 'So brake before the crest?', at: start - 4000 } });
    assert.equal(f.service.decorate(account).controls.pending, null);
    assert.equal(account.settings.replySource, 'local');
  }
});

test('plain names address one participant on all four profiles and cannot leak through a native parent', async t => {
  const f = fixture(t);
  for (const a of f.instances) {
    a.chat.messages = [msg('presence', 'cedar', '!points', 16_000),
      msg('question', 'viewerone', 'Cedar, which route did you take?', 15_000),
      msg('again', 'viewerone', 'And the other checkpoint?', 14_000, { replyParentId: 'question' }),
      msg('colon', 'viewertwo', 'CEDAR: which bridge?', 13_000),
      msg('greet', 'viewertwo', 'hey Cedar which bridge?', 12_000),
      msg('tail', 'viewertwo', 'Which one, Cedar?', 11_000),
      msg('host', 'viewerone', 'RallyRoom, which route?', 10_000),
      msg('pair', 'viewerone', 'Mainhost and Cedar, which route?', 8000),
      msg('cold', 'viewerone', 'Maple, which route did you take?', 7000)];
    await assert.rejects(f.service.request(a.id, body()), { code: 'no_conversation' });
  }
  assert.equal(f.calls.length, 0);
  for (const a of f.instances) a.chat.messages.push(msg('direct', 'viewerone', 'Hey MainHost, blue looks good.'));
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, 'Hey MainHost, blue looks good.');
  assert.deepEqual(f.contexts[0].messages, []);
  for (const id of ids.slice(1)) await assert.rejects(f.service.request(id, body()), { code: 'no_conversation' });
});

test('room calls, third-person references and names from another channel stay eligible', async t => {
  for (const text of ['chat, which route?', 'Where is Cedar playing?', 'Cedar is playing on which route?', 'Actually, which route did you take?', 'OtherRoom, which route?']) {
    const f = fixture(t);
    f.account.chat.messages = [msg('known', 'cedar', '!points', 1000), msg('room-word', 'chat', '!points', 1000),
      msg('foreign', 'otherroom', '!points', 1000, { channel: 'elsewhere' }), msg('target', 'viewerone', text)];
    await f.service.request('primary', body());
    assert.equal(f.contexts[0].target.text, text);
  }
});

test('a separate named turn from the target author leaves a retained draft and its exact source intact', async t => {
  const f = fixture(t);
  const text = 'Which turn comes after the crest?';
  f.account.chat.messages = [msg('known', 'cedar', 'nice', 3000), msg('source', 'viewerone', text, 2000)];
  await f.service.request('primary', body());
  f.calls[0].resolve('The left hairpin.'); await nextTurn();
  f.account.chat.messages.push(msg('aside', 'viewerone', 'Cedar: which gear did you use?'));
  assert.equal(f.status().state, 'completed');
  assert.deepEqual(f.status().result.target, { id: 'source', author: 'viewerone', text, at: start - 2000 });
  // A newly identified addressee must also withdraw a previously selected draft.
  const second = fixture(t);
  second.account.chat.messages = [msg('unknown', 'viewerone', 'Cedar: which gear?')];
  await second.service.request('primary', body());
  second.account.chat.messages.push(msg('first-seen', 'cedar', '!points'));
  assert.equal(second.status().state, 'cancelled');
  assert.equal(second.status().result, undefined);
});

test('an unthreaded follow-up to a mention wins over newer chatter, with only the same viewer as context', async t => {
  const f = fixture(t);
  f.account.chat.messages = [
    msg('mention', 'viewerone', '@mainhost is the handbrake useful here?', 50_000),
    msg('other', 'anotherfan', 'Those trees look good', 30_000),
    msg('follow', 'viewerone', 'I meant on gravel.', 10_000),
    msg('other2', 'anotherfan', 'Green car is back.')
  ].reverse();
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, 'I meant on gravel.');
  assert.deepEqual(f.contexts[0].messages, [{ author: 'viewerone', text: '@mainhost is the handbrake useful here?' }]);
});

test('an unthreaded correction uses the latest confirmed answer to that viewer and the earlier checkpoint detail', async t => {
  const f = fixture(t);
  f.account.chat.messages = [msg('earlier', 'viewerone', 'Where do I turn after the bridge checkpoint?', 70_000),
    msg('correction', 'viewerone', 'No, the other checkpoint.', 1000), msg('crowd', 'someoneelse', 'fun map')];
  const reply = { account: 'mainhost', channel, delivery: 'confirmed', replyTo: 'viewerone', text: 'Left at the bridge.', at: start - 60_000 };
  f.account.sent = [reply, { ...reply, at: start - 7000, replyTo: 'otherperson', text: 'Unrelated reply.' },
    { ...reply, at: start - 6000, delivery: 'pending', text: 'Still sending.' },
    { ...reply, at: start - 5000, channel: 'elsewhere', text: 'Different room.' },
    { ...reply, at: start - 4000, account: 'secondhost', text: 'Different account.' },
    { ...reply, at: start - 500, text: 'After the target.' }];
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, 'No, the other checkpoint.');
  assert.deepEqual(f.contexts[0].messages, [
    { author: 'viewerone', text: 'Where do I turn after the bridge checkpoint?' }, { author: 'mainhost', text: 'Left at the bridge.' }
  ]);
});

test('an unthreaded correction carries the previous native branch and chronological same-viewer detail', async t => {
  const f = fixture(t);
  f.account.chat.messages = [msg('old', 'viewerone', 'There are two checkpoints by the bridge.', 80_000),
    msg('native', 'viewerone', 'The far checkpoint?', 50_000, { replyParentId: 'own' }),
    msg('correction', 'viewerone', 'Sorry, the other checkpoint.', 1000), msg('crowd', 'someoneelse', 'fun map')];
  f.account.sent = [{ account: 'mainhost', channel, delivery: 'confirmed', messageId: 'own', text: 'The bridge exit is on the left.', at: start - 60_000 }];
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, 'Sorry, the other checkpoint.');
  assert.deepEqual(f.contexts[0].messages, [
    { author: 'viewerone', text: 'There are two checkpoints by the bridge.' }, { author: 'mainhost', text: 'The bridge exit is on the left.' },
    { author: 'viewerone', text: 'The far checkpoint?' }
  ]);
});

test('an actual viewer question survives newer spectator commentary even from the same author', async t => {
  const f = fixture(t);
  f.account.chat.messages = [msg('question', 'viewerone', 'How many laps are left?', 10_000),
    msg('remark', 'anotherfan', 'both of those guys are kind of jerks', 3000),
    msg('aside', 'viewerone', 'the lighting looks nice')];
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, 'How many laps are left?');
  f.calls[0].resolve('Which race are you asking about?');
  await nextTurn();
  assert.equal(f.status().state, 'completed');
  f.account.chat.messages.push(msg('aside2', 'viewerone', 'yeah the sky looks blue'));
  assert.equal(f.status().state, 'completed');
});

test('a room of offhand remarks, reactions, or invitations to insult someone gives a typed quiet outcome', async t => {
  const f = fixture(t);
  f.account.chat.messages = [msg('aside', 'viewerone', 'both of those guys are kind of jerks'),
    msg('offhand', 'viewertwo', 'beautiful lighting!'), msg('react', 'viewerone', 'lol???'),
    msg('insult', 'viewertwo', 'Are both those guys jerks?'),
    msg('direct-insult', 'viewertwo', '@mainhost why are those players such idiots?')];
  await assert.rejects(f.service.request('primary', body()), { status: 409, code: 'no_conversation' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.decorate(f.account).controls.pending, null);
});

test('room questions in different scripts, requests without punctuation, and invitations are eligible', async t => {
  for (const text of ['أين نقطة التفتيش؟', '次の関門はどこ？', '¿Qué vuelta es esta?', 'Alguien sabe dónde empieza la vuelta',
    'このモードの開放方法を教えてください', 'chat, anyone know the next map', 'Please show the route', "Who’s up for another round"]) {
    const f = fixture(t);
    f.account.chat.messages = [msg('request', 'viewerone', text)];
    await f.service.request('primary', body());
    assert.equal(f.contexts[0].target.text, text);
  }
});

test('a direct non-English conversational turn needs no question words or punctuation', async t => {
  const f = fixture(t);
  f.account.chat.messages = [msg('direct', 'viewerone', '@mainhost 青い方にしたよ'), msg('aside', 'anotherviewer', 'beautiful sky')];
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, '@mainhost 青い方にしたよ');
});

test('a moderation question quoting abuse is eligible and an invitation to pile on stays quiet', async t => {
  const f = fixture(t);
  const question = 'How can I mute someone who calls me an idiot?';
  f.account.chat.messages = [msg('moderation', 'viewerone', question, 2000), msg('pileon', 'viewerother', 'Should we call the driver an idiot?')];
  await f.service.request('primary', body());
  assert.equal(f.contexts[0].target.text, question);
});

test('the first unthreaded answer to the account’s question retains the viewer’s own words', async t => {
  const f = fixture(t);
  f.account.chat.messages = [msg('answer', 'viewerone', '黄緑に紫のホイール。', 10_000), msg('aside', 'viewerone', 'the sky looks nice')];
  f.account.sent = [{ account: 'mainhost', channel, replyTo: 'viewerone', delivery: 'confirmed', at: start - 20_000, text: 'どんな色にした？' }];
  await f.service.request('primary', body());
  assert.deepEqual(f.contexts[0].target, { author: 'viewerone', text: '黄緑に紫のホイール。' });
  assert.deepEqual(f.contexts[0].messages, [{ author: 'mainhost', text: 'どんな色にした？' }]);
  f.calls[0].resolve('紫のホイールなんだね。');
  await nextTurn();
  assert.equal(f.status().state, 'completed');
});

test('model abstention produces a completed, unsendable receipt and a clear operator reason', async t => {
  const f = fixture(t);
  await f.service.request('primary', body());
  f.calls[0].reject(Object.assign(new Error('private model detail'), { code: 'no_reply' }));
  await nextTurn();
  const { command } = await f.service.request('primary', body());
  assert.equal(command.state, 'completed');
  assert.equal(command.error, '');
  assert.deepEqual(command.result, { suggested: false, reason: 'No reply suggested. The conversation does not call for a response.' });
  assert.equal(command.result.text, undefined);
  assert.equal(command.result.targetAuthor, undefined);
  assert.equal(f.calls.length, 1);
});

test('retry is idempotent during generation and after completion, while a new request waits', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.service.request('primary', body()), f.service.request('primary', body())]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.service.request('primary', body('second')), { status: 409 });
  f.calls[0].resolve('The gravel makes it slide.');
  await nextTurn();
  assert.deepEqual((await f.service.request('primary', body())).command, f.status());
  assert.equal(f.calls.length, 1);
});

test('an emergency Stop stays visible alongside every helper command and cancels an in-flight reply', async t => {
  const f = fixture(t);
  await f.service.request('primary', body());
  const stop = { requestId: 'stop1', action: 'stop', state: 'queued', createdAt: start };
  const previous = { requestId: 'older', action: 'settings', state: 'completed', createdAt: start - 1000 };
  f.account.controls = { pending: stop, recent: [previous] };
  const { controls } = f.service.decorate(f.account);
  assert.equal(controls.pending, stop);
  assert.ok(controls.recent.includes(previous));
  assert.equal(f.status().state, 'cancelled');
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve('obsolete text');
  await nextTurn();
  assert.equal(f.status().result, undefined);
  assert.deepEqual(f.account.controls, { pending: stop, recent: [previous] });
});

test('a completed draft is withdrawn when its original account, room, broadcast or target changes', async t => {
  const changes = [
    account => { account.account = 'newmain'; },
    account => { account.channel = account.settings.allowedChannel = 'newroom'; },
    account => { account.streamContext.streamId = '456'; },
    account => { account.chat.messages = []; },
    account => { account.settings.paused = true; }
  ];
  for (const change of changes) {
    const f = fixture(t);
    await f.service.request('primary', body());
    f.calls[0].resolve('Brake earlier.');
    await nextTurn();
    assert.equal(f.status().state, 'completed');
    change(f.account);
    const result = await f.service.request('primary', body());
    assert.equal(result.command.state, 'cancelled');
    assert.equal(result.command.result, undefined);
  }
});

test('generation rechecks the broadcast and viewer identity, and invalidation supersedes an in-flight snapshot', async t => {
  for (const change of [f => { f.account.streamContext.streamId = '456'; }, f => { f.instances[2].account = 'viewerone'; }]) {
    const f = fixture(t);
    await f.service.request('primary', body());
    change(f);
    f.calls[0].resolve('Outdated reply');
    await nextTurn();
    assert.equal(f.status().state, 'cancelled');
    assert.equal(f.status().result, undefined);
  }
  let ready;
  const f = fixture(t, { snapshot: () => new Promise(r => { ready = r; }) });
  const request = f.service.request('primary', body());
  f.service.invalidate('primary');
  ready({ instances: f.instances });
  await assert.rejects(request, { status: 409 });
  assert.equal(f.calls.length, 0);
});

test('polling withdraws a finished draft when another helper takes the viewer identity', async t => {
  const f = fixture(t);
  await f.service.request('primary', body());
  f.calls[0].resolve('Brake earlier.');
  await nextTurn();
  f.instances[1].account = 'viewerone';
  assert.equal(f.service.decorate(f.account, f.instances).controls.recent[0].state, 'cancelled');
  assert.equal(f.status().result, undefined);
});

test('a newer follow-up supersedes a pending or displayed draft while unrelated chatter leaves it available', async t => {
  for (const stage of ['running', 'completed']) {
    const f = fixture(t);
    f.account.chat.messages = [msg('first', 'viewerone', 'At the bridge checkpoint?', 14_000, { replyParentId: 'own' })];
    f.account.sent = [{ account: 'mainhost', channel, delivery: 'confirmed', messageId: 'own', text: 'Left at the bridge.', at: start - 20_000 }];
    await f.service.request('primary', body());
    if (stage === 'completed') { f.calls[0].resolve('Yes, at the bridge.'); await nextTurn(); }
    f.account.chat.messages.push(msg('otherfan', 'viewerfour', 'What about the wall?', 5000),
      msg('otherchat', 'viewerone', 'Which circuit?', 4000, { channel: 'otherroom' }),
      msg('otherthread', 'viewerone', 'Different question', 3000, { replyParentId: 'someone-else' }),
      msg('otherperson', 'viewerone', '@otherfan I agree', 2000));
    assert.equal(f.status().state, stage);
    f.account.chat.messages.push(msg('correction', 'viewerone', 'No, the other checkpoint.', 0,
      stage === 'completed' ? { replyParentId: 'first' } : {}));
    if (stage === 'running') { f.calls[0].resolve('Yes, at the bridge.'); await nextTurn(); }
    assert.equal(f.status().state, 'cancelled');
    assert.match(f.status().error, /newer message from @viewerone/);
    assert.equal(f.status().result, undefined);
    await f.service.request('primary', body('fresh'));
    assert.equal(f.contexts[1].target.text, 'No, the other checkpoint.');
  }
});

test('unavailable, unbound, stale, stopped or busy accounts return actionable errors before model invocation', async t => {
  const checks = [
    [account => { account.available = false; }, /status/],
    [account => { account.checkedAt = new Date(start - 60_000).toISOString(); }, /out of date/],
    [account => { account.connected = false; }, /Reconnect/],
    [account => { account.settings.allowedChannel = 'elsewhere'; }, /configured channel/],
    [account => { account.browser.lastSeenAt = new Date(start - 60_000).toISOString(); }, /browser/],
    [account => { account.settings.paused = true; }, /stopped/],
    [account => { account.controls.pending = { action: 'watch' }; }, /in progress/]
  ];
  for (const [change, expected] of checks) {
    const f = fixture(t);
    change(f.account);
    await assert.rejects(f.service.request('primary', body()), expected);
    assert.equal(f.calls.length, 0);
  }
});

test('no candidate is created from other accounts, automation, old messages, foreign replies, commands, or links', async t => {
  const f = fixture(t);
  f.instances[3].account = '';
  f.account.chat.messages = [
    msg('self', 'mainhost', 'Should we go left?'), msg('other', 'fourthhost', 'Can we see the lap time?'),
    msg('daemon', 'nightbot', 'Another poll is ready'), msg('flag', 'normalname', 'Thanks for the follow!', 0, { isBot: true }),
    msg('faded', 'viewerone', 'How is the track?', 121_000), msg('addressed', 'viewerone', '@someoneelse which lap?'),
    msg('badparent', 'viewerone', 'What about the wall?', 0, { replyParentId: 'unknown' }),
    msg('cmd', 'viewerone', '!points'), msg('link', 'viewerone', 'try https://example.test'),
    msg('foreign', 'viewerone', 'Where are we going?', 0, { channel: 'elsewhere' })
  ];
  await assert.rejects(f.service.request('primary', body()), /no recent viewer/);
  assert.equal(f.calls.length, 0);
});

test('accepts only the reply-draft command and validates the model output without exposing diagnostics', async t => {
  const f = fixture(t);
  for (const invalid of [{ ...body(), action: 'send', params: { text: 'hi there' } }, { ...body(), params: { mode: 'summary' } },
    { ...body(), thread: 'new' }, body('bad id')]) await assert.rejects(f.service.request('primary', invalid), { status: 400 });
  assert.equal(f.calls.length, 0);
  await f.service.request('primary', body());
  f.calls[0].resolve('/ban viewerone');
  await nextTurn();
  assert.equal(f.status().state, 'failed');
  assert.equal(f.status().result, undefined);
  assert.doesNotMatch(f.status().error, /ban/);
  await f.service.request('primary', body('second'));
  f.calls[1].reject(new Error('private detail'));
  await nextTurn();
  assert.doesNotMatch(f.status('second').error, /private detail/);
});

test('expiration releases per-account capacity, and host shutdown aborts all outstanding generations', async t => {
  const f = fixture(t);
  await f.service.request('primary', body());
  f.advance(31_000);
  assert.equal(f.status().state, 'expired');
  assert.ok(f.calls[0].signal.aborted);
  await f.service.request('primary', body('newer'));
  await f.service.request('fourth', body('newest'));
  f.service.stop();
  assert.ok(f.calls[1].signal.aborted && f.calls[2].signal.aborted);
  await assert.rejects(f.service.request('primary', body('late')), { status: 503 });
  f.advance(300_000);
  assert.equal(f.status(), undefined);
});
