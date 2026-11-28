import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateOperatorDraft } from '../lib/operator-model.mjs';

const context = {
  account: 'operator', channel: 'fixture_channel', stream: { title: 'Final', category: 'Racing' },
  messages: [{ author: 'host', text: 'The north gate opens at noon.' }],
  target: { author: 'viewer', text: 'When does that gate open?' }
};

function fixture(script) {
  return (bin, args, options) => {
    assert.ok(bin.endsWith('/private/operator-draft'));
    assert.deepEqual(args, []);
    assert.equal(options.shell, false);
    assert.equal(options.stdio[2], 'ignore');
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
    return spawn(process.execPath, ['-e', script], options);
  };
}

const responds = text => fixture(`process.stdin.resume(); process.stdout.write(${JSON.stringify(JSON.stringify({ text }))})`);
const errorCode = code => error => error.code === code;

test('only the selected message, bounded conversation and public metadata reach the private helper', async () => {
  const rows = Array.from({ length: 50 }, (_, n) => ({ author: 'host', text: 'x'.repeat(320) + n, private: 'secret' }));
  const input = { ...context, private: 'secret', stream: { ...context.stream, hidden: 'secret' },
    messages: [...rows, context.target], target: { ...context.target, hidden: 'secret' } };
  const script = `let body=''; process.stdin.on('data', chunk=>body+=chunk);
    process.stdin.on('end',()=>{ const d=JSON.parse(body);
      if(body.includes('secret') || d.messages.length>12 || !d.messages.length ||
        d.messages.reduce((n,m)=>n+m.text.length,0)>2200 || !d.messages.at(-1).text.endsWith('49') ||
        d.messages.some(x=>x.text===d.target.text) || d.target.text!=='When does that gate open?' || d.stream.title!=='Final') process.exit(65);
      process.stdout.write(JSON.stringify({text:'The north gate opens at noon.'})); });`;
  assert.equal(await generateOperatorDraft(input, { spawnImpl: fixture(script) }), 'The north gate opens at noon.');
});

test('rejects malformed selectors and pre-cancelled work before spawning', async () => {
  const spawnImpl = () => assert.fail('unexpected helper spawn');
  for (const input of [{ ...context, channel: 'bad/room' }, { ...context, target: { author: 'viewer', text: 'q\nnext' } }]) {
    await assert.rejects(generateOperatorDraft(input, { spawnImpl }), errorCode('invalid_context'));
  }
  await assert.rejects(generateOperatorDraft(context, { signal: AbortSignal.abort(), spawnImpl }), errorCode('draft_cancelled'));
});

test('withholds commands, multiline, blank, oversized and linked model output', async () => {
  for (const value of ['/ban someone', 'line one\nline two', ' ', 'a'.repeat(301), 'try https://example.com', 'example.jp/help', 'hidden\u202estring']) {
    await assert.rejects(generateOperatorDraft(context, { spawnImpl: responds(value) }), errorCode('invalid_draft'));
  }
});

test('propagates unavailable model and handles malformed or excessive output without revealing it', async () => {
  await assert.rejects(generateOperatorDraft(context, { spawnImpl: fixture('process.exit(69)') }), errorCode('model_unavailable'));
  for (const raw of ['invalid response containing the fixture secret', 'x'.repeat(2500)]) {
    await assert.rejects(generateOperatorDraft(context, {
      spawnImpl: fixture(`process.stdin.resume();process.stdout.write(${JSON.stringify(raw)})`)
    }), error => error.code === 'invalid_draft' && !error.message.includes(raw));
  }
  await assert.rejects(generateOperatorDraft(context, { spawnImpl: (_, __, options) => spawn('/nonexistent/draft-helper', [], options) }),
    errorCode('model_unavailable'));
});

test('a stalled helper is stopped on timeout or explicit cancellation', async () => {
  const idle = fixture('process.stdin.resume(); setInterval(()=>{},1000);');
  await assert.rejects(generateOperatorDraft(context, { spawnImpl: idle, timeoutMs: 100 }), errorCode('model_timeout'));
  const stop = new AbortController();
  const draft = generateOperatorDraft(context, { spawnImpl: idle, signal: stop.signal });
  stop.abort();
  await assert.rejects(draft, errorCode('draft_cancelled'));
});
