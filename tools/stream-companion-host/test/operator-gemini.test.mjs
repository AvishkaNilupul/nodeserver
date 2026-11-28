import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGeminiDraft } from '../lib/operator-gemini.mjs';

const key = 'fixture-google-key';
const context = { account: 'reviewer_login', channel: 'room_login',
  messages: [{ author: 'viewer_login', text: 'Did you know Addison says two seconds but adds two minutes?' }],
  target: { author: 'viewer_login', text: 'Is it an Add-ison joke?' },
  stream: { category: 'Deadlock', title: 'Personal title', streamId: 'stream-id', extra: 'private' } };
const reply = (value, finishReason = 'STOP') => Response.json({ candidates: [{ finishReason,
  content: { parts: [{ text: JSON.stringify({ reply: value }) }] } }] });
const options = fetchImpl => ({ fetchImpl, apiKey: key });
const code = expected => e => e.code === expected;

// Exercise the HTTP contract rather than substituting a generator. The fake
// provider must be able to distinguish the anonymous viewer and the operator.
test('the wordplay setup reaches Gemini as untrusted quoted chat and the response is an editable string', async () => {
  const generated = await generateGeminiDraft(context, options(async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(init.method, 'POST'); assert.equal(init.headers['x-goog-api-key'], key);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.doesNotMatch(init.body, /reviewer_login|viewer_login|room_login|Personal title|stream-id|fixture-google-key/);
    const body = JSON.parse(init.body), excerpt = JSON.parse(body.contents[0].parts[0].text);
    assert.deepEqual(excerpt, { prior: [{ speaker: '[target viewer]', text: context.messages[0].text }],
      target: { speaker: '[target viewer]', text: context.target.text }, listedCategory: 'Deadlock' });
    assert.match(body.systemInstruction.parts[0].text, /wordplay/);
    assert.equal(body.generationConfig.responseSchema.properties.reply.nullable, true);
    assert.equal(body.tools, undefined);
    return reply('Those are some generous seconds.');
  }));
  assert.equal(generated, 'Those are some generous seconds.');
});

test('the provider may withhold a response to an unseen card', async () => {
  await assert.rejects(generateGeminiDraft({ ...context, target: { author: 'viewer_login', text: 'Is that foil?' } }, options(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.systemInstruction.parts[0].text, /only text/);
    assert.equal(JSON.parse(body.contents[0].parts[0].text).target.text, 'Is that foil?');
    return reply(null);
  })), code('no_reply'));
});

test('removes handles in text and metadata, omits risky context, extra fields and the credential', async () => {
  const input = { ...context, knownIdentities: ['secret'], target: { author: 'VIEWER_LOGIN', text: '@Reviewer_Login, what is the stream title?' },
    stream: { category: 'Deadlock', title: 'Room_Login plays with @UnlistedPerson' }, messages: [
      { author: 'Viewer_Login', text: 'UnlistedPerson says SideViewer and room_login talked with @UnlistedPerson.' },
      { author: 'reviewer_login', text: 'My password = hide-this.' }, { author: 'viewer_login', text: key },
      { author: 'ancient_user', text: 'contact abc@example.com' }, { author: 'ancient_user', text: 'OAuth:testing-secret' },
      { author: 'ancient_user', text: 'Look /Users/private_user/files' }, { author: 'ancient_user', text: 'The token was [redacted].' },
      { author: 'reviewer_login', text: 'Which title did you see?' }] };
  await generateGeminiDraft(input, { apiKey: key, knownLogins: ['sideviewer'], fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), excerpt = JSON.parse(body.contents[0].parts[0].text);
    assert.doesNotMatch(init.body, /room_login|reviewer_login|viewer_login|sideviewer|unlistedperson|example\.com|hide-this|testing-secret|fixture-google-key|ancient_user|private_user|\[redacted\]/i);
    assert.equal(excerpt.prior.length, 2);
    assert.equal(excerpt.prior[1].speaker, '[operator]');
    const person = excerpt.prior[0].text.match(/with (\[viewer \d+\])/)[1];
    assert.equal(excerpt.listedTitle, `[broadcaster] plays with ${person}`);
    assert.ok(excerpt.prior[0].text.startsWith(person + ' says'));
    assert.match(excerpt.target.text, /^\[operator\]/);
    return reply('What did it say yesterday?');
  } });
});

test('bounds the selected excerpt without dropping the target, refuses unsafe target and avoids calling Google', async () => {
  const rows = Array.from({ length: 18 }, (_, n) => ({ author: 'viewer_login', text: 'some words '.repeat(41) + n }));
  await generateGeminiDraft({ ...context, messages: rows }, options(async (_url, init) => {
    const excerpt = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text);
    assert.ok(excerpt.prior.length <= 8 && excerpt.prior.length > 0);
    assert.ok(excerpt.prior.reduce((s, row) => s + row.text.length, 0) <= 2000);
    assert.match(excerpt.prior.at(-1).text, /17$/); assert.equal(excerpt.target.text, context.target.text);
    return reply('Sure.');
  }));
  for (const text of ['my API key is stolen-credential', 'bare string ' + 'a1'.repeat(20), 'archive at https://example.org', key]) {
    await assert.rejects(generateGeminiDraft({ ...context, target: { author: 'viewer_login', text } }, options(() => assert.fail('unexpected fetch'))), code('no_reply'));
  }
  await assert.rejects(generateGeminiDraft({ ...context, account: 'bad/profile' }, options(() => assert.fail('unexpected fetch'))), code('invalid_context'));
  await assert.rejects(generateGeminiDraft(context, { apiKey: 'bad\nheader', fetchImpl: () => assert.fail() }), code('model_unavailable'));
});

test('does not retry or disclose provider diagnostics on HTTP, network, quota or blocked responses', async () => {
  let calls = 0;
  const callbacks = [
    [() => new Response(key, { status: 429 }), 'model_rate_limited'],
    [() => new Response(key, { status: 403 }), 'model_unavailable'],
    [() => new Response(key, { status: 500 }), 'model_unavailable'],
    [() => { throw Error(key); }, 'model_unavailable'],
    [() => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), 'no_reply'],
    [() => reply('anything', 'SAFETY'), 'no_reply']
  ];
  for (const [response, expected] of callbacks) {
    await assert.rejects(generateGeminiDraft(context, options(() => { calls++; return response(); })), e => {
      assert.equal(e.code, expected); assert.ok(!e.message.includes(key)); return true;
    });
  }
  assert.equal(calls, callbacks.length);
});

test('rejects malformed, oversized, truncated, linked and identifying provider outputs', async () => {
  for (const value of ['', '/ban user', 'line one\nline two', 'text\u202etest', '!deck', 'visit the.site', 'a'.repeat(301),
    'hello @user', 'hello [target viewer]', 'hello [viewer 3]', key]) {
    await assert.rejects(generateGeminiDraft(context, options(() => reply(value))), code('invalid_draft'));
  }
  const corrupt = ['no json', '{}', '{"reply":"ok","extra":true}'];
  for (const output of [() => reply('ok', 'MAX_TOKENS'), () => new Response(' '.repeat(40_000)),
    ...corrupt.map(text => () => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }))]) {
    await assert.rejects(generateGeminiDraft(context, options(output)), code('invalid_draft'));
  }
});

test('withholds model commentary and preserves a normal conversational line', async () => {
  for (const text of ['Suggested reply: that’s an expensive second.', 'The viewer is asking about a pun.', 'As an AI I cannot see the card.']) {
    await assert.rejects(generateGeminiDraft(context, options(() => reply(text))), code('no_reply'));
  }
  const line = 'That’s one way to make every second count.';
  assert.equal(await generateGeminiDraft(context, options(() => reply(line))), line);
});

test('cancels the outgoing request on operator stop and times out before the host receipt deadline', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(Error('transport did not abort')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  const pending = generateGeminiDraft(context, { apiKey: key, fetchImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, code('draft_cancelled'));
  await assert.rejects(generateGeminiDraft(context, { apiKey: key, fetchImpl: () => assert.fail(), signal: controller.signal }), code('draft_cancelled'));
  await assert.rejects(generateGeminiDraft(context, { apiKey: key, fetchImpl, timeoutMs: 10 }), code('model_timeout'));
});
