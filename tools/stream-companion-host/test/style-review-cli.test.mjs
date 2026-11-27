import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBank, validateBank } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';
import { STYLE_PROFILES } from '../lib/style-catalog.mjs';
import { parseArguments, runReview } from '../scripts/review-chat-style.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'companion-style-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bank = join(root, 'bank.json'), history = join(root, 'history.json'), output = join(root, 'proposal');
  await writeFile(bank, JSON.stringify({ revision: 8, bank: defaultBank() }));
  await writeFile(history, JSON.stringify({ capturedAt: '2026-11-27T12:00:00Z', history: [
    { id: 1, accountId: 'primary', channel: 'fixture_channel', streamId: 'stream1', kind: 'greeting', text: 'hi chat', textAvailable: true, delivery: 'confirmed', at: 1000 }
  ] }));
  return { root, bank, history, output, args: ['--bank', bank, '--history', history, '--output', output] };
}

test('offline CLI writes private review and a schema-valid proposal without changing inputs', async t => {
  const f = await fixture(t), before = await Promise.all([readFile(f.bank), readFile(f.history)]);
  const result = await runReview(f.args);
  assert.equal(result.liveApplied, false); assert.equal(result.referenceRevision, 8); assert.equal(result.entries, 124);
  const bank = JSON.parse(await readFile(join(f.output, 'candidate-bank.json'), 'utf8'));
  validateBank(bank); assert.equal(bank.profiles.length, 4);
  assert.deepEqual(await Promise.all([readFile(f.bank), readFile(f.history)]), before);
  const proposal = JSON.parse(await readFile(join(f.output, 'proposal.json'), 'utf8'));
  assert.equal(proposal.liveApplied, false); assert.equal(proposal.referenceRevision, 8);
  assert.match(proposal.sourceBankSha256, /^[a-f0-9]{64}$/);
  const review = JSON.parse(await readFile(join(f.output, 'review.json'), 'utf8'));
  assert.equal(review.inputCapturedAt, '2026-11-27T12:00:00Z'); assert.equal(review.review.confirmedRows, 1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.output)).mode & 0o777, 0o700);
    for (const name of ['candidate-bank.json', 'proposal.json', 'review.json']) assert.equal((await stat(join(f.output, name))).mode & 0o777, 0o600);
  }
});

test('existing output is never overwritten, including an unrelated canary', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'canary'), 'keep');
  await assert.rejects(runReview(f.args), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.output, 'canary'), 'utf8'), 'keep');
});

test('reviewed normalized feedback keys reach both proposal filtering and evidence review', async t => {
  const f = await fixture(t), key = messageKey(STYLE_PROFILES.primary.replies.thanks[0]);
  assert.equal(key.length, 16);
  const feedback = join(f.root, 'feedback.json'); await writeFile(feedback, JSON.stringify({ avoidTextKeys: [key] }));
  await runReview([...f.args, '--feedback', feedback]);
  const bank = JSON.parse(await readFile(join(f.output, 'candidate-bank.json'), 'utf8'));
  assert.ok(!bank.entries.filter(e => e.id.startsWith('style:')).some(e => e.lines.some(line => messageKey(line) === key)));
  const review = JSON.parse(await readFile(join(f.output, 'review.json'), 'utf8'));
  assert.deepEqual(review.review.explicitNegativeFeedback.suppliedKeys, [key]);
});

test('malformed feedback is rejected before any output is created', async t => {
  const f = await fixture(t), path = join(f.root, 'feedback.json');
  await writeFile(path, JSON.stringify({ avoidTextKeys: ['a'.repeat(64)] }));
  await assert.rejects(runReview([...f.args, '--feedback', path]), /Feedback/);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('arguments reject duplicates, missing values and unsupported side effects', () => {
  assert.deepEqual(parseArguments(['--help']), { help: true });
  for (const args of [[], ['--bank'], ['--apply', 'yes'], ['--bank', 'a', '--bank', 'b'], ['--bank', 'a', '--output', 'b']]) assert.throws(() => parseArguments(args));
});
