import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultBank, validateBank, PROFILE_IDS, EVENT_CATEGORIES } from '../lib/bank.mjs';
import { prepareStyleBank } from '../lib/style-review.mjs';
import { prepareEventBank, EVENT_WORDING } from '../lib/event-catalog.mjs';
import { messageKey } from '../lib/exchanges.mjs';
import { prepare } from '../scripts/prepare-event-bank.mjs';

test('twenty per-account event groups extend 124 styles to144 without rewriting any old entry or preference', () => {
  const old = prepareStyleBank(defaultBank()).bank, before = structuredClone(old), result = prepareEventBank(old);
  assert.equal(old.entries.length, 124); assert.equal(result.bank.entries.length, 144); assert.equal(result.manifest.added, 20);
  assert.deepEqual(old, before); assert.deepEqual(result.bank.entries.slice(0, 124), old.entries); assert.deepEqual(result.bank.profiles, old.profiles);
  for (const id of PROFILE_IDS) for (const category of EVENT_CATEGORIES) {
    const entry = result.bank.entries.find(e => e.id === `event:${id}:${category}`);
    assert.deepEqual(entry.accountIds, [id]); assert.equal(entry.enabled, true); assert.equal(entry.lines.length, 2);
  }
  assert.equal(new Set(Object.values(EVENT_WORDING).flatMap(x => Object.values(x).flat()).map(messageKey)).size, 40);
  assert.ok(Object.isFrozen(EVENT_WORDING.third.gift));
});

test('repeat proposal preserves edited wording, disabled groups, selective assignments and all exchange identities', () => {
  const first = prepareEventBank(defaultBank()).bank;
  const entry = first.entries.find(e => e.id === 'event:primary:bits');entry.lines = ['a reviewed cheer'];entry.enabled = false;entry.accountIds = ['test'];
  const second = prepareEventBank(first);assert.deepEqual(second.bank, first);assert.equal(second.manifest.added, 0);
  assert.deepEqual(second.bank.entries.filter(e => e.kind === 'exchange'), defaultBank().entries.filter(e => e.kind === 'exchange'));
});

test('identity collisions, group160 bound, byte limits and unsupported fact substitutions fail closed', () => {
  const collision = defaultBank();collision.entries[0].id = 'event:primary:bits';assert.throws(() => prepareEventBank(collision), /identity/);
  const large = defaultBank();large.entries = Array.from({ length: 141 }, (_, i) => ({ ...large.entries[0], id: `fixture:${i}` }));assert.throws(() => prepareEventBank(large), /large/);
  const bank = prepareEventBank(defaultBank()).bank, event = bank.entries.find(e => e.kind === 'event');
  for (const text of ['{actor} cheered', '{bits} bits', '{months} months', '/command', 'https://example.test']) { event.lines = [text];assert.throws(() => validateBank(bank)); }
  event.lines = ['a'.repeat(261)];assert.throws(() => validateBank(bank));
  const sized = defaultBank();sized.entries = Array.from({ length: 160 }, (_, i) => ({ ...sized.entries[0], id: `fixture:${i}`, lines: ['a'.repeat(260), 'b'.repeat(260)] }));assert.throws(() => validateBank(sized), /large/);
});

test('offline CLI writes only a guarded private proposal, excludes response metadata and refuses overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'event-bank-'));t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'saved.json'), output = join(root, 'proposal');
  await writeFile(input, JSON.stringify({ revision: 9, bank: prepareStyleBank(defaultBank()).bank, csrfToken: 'PRIVATE_SENTINEL' }));
  const result = await prepare(['--bank', input, '--output', output]);assert.equal(result.added, 20);assert.equal(result.automaticActivation, false);
  const proposal = JSON.parse(await readFile(join(output, 'proposal.json'), 'utf8'));
  assert.equal(proposal.request.expectedRevision, 9);assert.deepEqual(Object.keys(proposal.request), ['requestId', 'expectedRevision', 'bank']);
  assert.doesNotMatch(JSON.stringify(proposal), /PRIVATE_SENTINEL/);assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'candidate-bank.json'))).mode & 0o777, 0o600);
  await assert.rejects(prepare(['--bank', input, '--output', output]), /exist/);
});
