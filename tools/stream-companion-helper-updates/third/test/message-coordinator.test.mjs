import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MessageCoordinator } from '../lib/message-coordinator.mjs';
import { messageKey } from '../extension/message-policy.js';

const now = 1_800_000_000_000;
const intent = (extra = {}) => ({ account: 'first_account', channel: 'friend_channel',
  streamId: '123456789', kind: 'topic', text: 'what do you enjoy most about Minecraft?', ...extra });
async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-dedupe-'));
  const file = join(directory, 'messages.sqlite');
  const db = new MessageCoordinator({ file, now: () => now });
  t.after(() => { db.close(); });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { db, file };
}

test('punctuation/case echoes are blocked across helpers and other channels stay independent', async t => {
  const { db, file } = await store(t);
  const other = new MessageCoordinator({ file, now: () => now }); t.after(() => other.close());
  const first = db.reserve(intent({ kind: 'greeting', text: 'Hey, CHAT!!' }));
  assert.equal(first.ok, true);
  assert.equal(other.reserve(intent({ account: 'second_account', kind: 'greeting', text: 'hey chat' })).ok, false);
  assert.equal(other.reserve(intent({ account: 'second_account', kind: 'greeting', text: 'hello everyone' })).ok, true);
  assert.equal(other.reserve(intent({ channel: 'another_channel', kind: 'greeting', text: 'hey chat' })).ok, true);
  assert.equal(messageKey('how’s your day?'), messageKey("HOWS YOUR DAY!!!"));
});

test('category-question reservation survives restart and prevents paraphrases in the same broadcast', async t => {
  const { db, file } = await store(t);
  const claim = db.reserve(intent()); db.finish(claim.reservationId, 'unknown');
  const reopened = new MessageCoordinator({ file, now: () => now }); t.after(() => reopened.close());
  assert.equal(reopened.reserve(intent({ account: 'second_account', text: 'what got you interested in Minecraft?' })).ok, false);
  assert.equal(reopened.reserve(intent({ streamId: '987654321', text: 'what got you interested in Minecraft?' })).ok, true);
  assert.deepEqual(reopened.snapshot('friend_channel').topicStreams.sort(), ['123456789', '987654321']);
});

test('proven rejection/cancellation release a reservation; pending and unknown keep it', async t => {
  const { db } = await store(t);
  for (const delivery of ['rejected', 'cancelled']) {
    const claim = db.reserve(intent()); assert.equal(claim.ok, true);
    db.finish(claim.reservationId, delivery);
  }
  const pending = db.reserve(intent());
  assert.equal(db.reserve(intent({ account: 'second_account' })).ok, false);
  db.finish(pending.reservationId, 'unknown');
  assert.equal(db.reserve(intent({ account: 'second_account' })).ok, false);
});

test('a shared incoming message gets only one answer even when wording differs', async t => {
  const { db } = await store(t);
  assert.equal(db.reserve(intent({ kind: 'conversation', replyTo: 'incoming-1', text: 'you’re welcome' })).ok, true);
  assert.equal(db.reserve(intent({ account: 'second_account', kind: 'conversation', replyTo: 'incoming-1', text: 'no worries' })).ok, false);
  assert.equal(db.reserve(intent({ account: 'second_account', kind: 'conversation', replyTo: 'incoming-2', text: 'no worries' })).ok, true);
});

test('text expires after an hour while the broadcast topic remains consumed', async t => {
  let time = now;
  const db = new MessageCoordinator({ file: ':memory:', now: () => time }); t.after(() => db.close());
  const claim = db.reserve(intent()); db.finish(claim.reservationId, 'confirmed');
  time += 3_600_001;
  assert.deepEqual(db.snapshot('friend_channel').textKeys, []);
  assert.equal(db.reserve(intent({ account: 'second_account', text: 'a new category question' })).ok, false);
  assert.equal(db.reserve(intent({ streamId: 'new-broadcast' })).ok, true);
});

test('seeding each own history is idempotent and shares no message bodies or credentials', async t => {
  const { db, file } = await store(t);
  const history = [{ ...intent(), at: now - 1000, delivery: 'confirmed' },
    { ...intent({ text: 'rejected greeting', kind: 'greeting' }), at: now - 2000, delivery: 'rejected' }];
  db.register('second_account'); db.seed(history); db.seed(history);
  const snapshot = db.snapshot('friend_channel');
  assert.deepEqual(snapshot.textKeys, [messageKey(history[0].text)]);
  assert.deepEqual(snapshot.accounts, ['first_account', 'second_account']);
  assert.equal(JSON.stringify(snapshot).includes(history[0].text), false);
  assert.equal((await readFile(file)).includes(Buffer.from(history[0].text)), false);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM contributions').get().n, 1);
});

test('two independent Node processes racing a category question have exactly one winner', async t => {
  const { file } = await store(t);
  const source = `import { MessageCoordinator } from ${JSON.stringify(new URL('../lib/message-coordinator.mjs', import.meta.url).href)};
    const db = new MessageCoordinator({file:process.argv[1],now:()=>${now}});
    const claim=db.reserve(JSON.parse(process.argv[2])); db.close(); console.log(JSON.stringify(claim));`;
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, file, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(Error(stderr)));
  });
  const results = await Promise.all([run(intent()), run(intent({ account: 'second_account', text: 'what keeps Minecraft interesting for you?' }))]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(results.filter(x => !x.ok).length, 1);
});
