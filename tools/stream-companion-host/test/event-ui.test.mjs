import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBank, validateBank } from '../lib/bank.mjs';
import { prepareStyleBank } from '../lib/style-review.mjs';
import { prepareEventBank } from '../lib/event-catalog.mjs';
import { bankValidation, createDirectorController, createMessagesView, renderMessages, timelineRow } from '../public/messages.js';

const at = 1_800_000_000_000;
const saved = bank => ({ protocol: 1, ready: true, updatedAt: new Date(at).toISOString(), csrfToken: 'synthetic-csrf', revision: 9, bank, profiles: [], plans: [], history: [], imports: [], nextBeforeId: null });
class Node {
  constructor() { this.children = [];this.listeners = {};this._text = '';this.value = '';this.hidden = false; }
  set innerHTML(_) { throw Error('Dynamic HTML forbidden'); }
  set textContent(value) { this._text = String(value);this.children = []; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  get options() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes;this._text = ''; }
  setAttribute() {}
  addEventListener(name, action) { this.listeners[name] = action; }
}
const doc = () => { const nodes = new Map();return { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node());return nodes.get(id); }, createElement() { return new Node(); } }; };

test('event category is editable in the existing bank form and dirty wording survives a fresh poll', async () => {
  const bank = prepareEventBank(defaultBank()).bank, data = saved(bank);
  const c = createDirectorController({ now: () => at, fetchImpl: async () => Response.json(data) });await c.refresh();
  const document = doc(), view = createMessagesView(document, c);renderMessages(view, c.getState(), c, at);
  const id = 'event:primary:bits', card = view.entries.get(id);assert.equal(card.categoryField.hidden, false);assert.equal(card.category.options.length, 5);
  assert.ok(card.category.options.some(x => x.value === 'gift_batch' && /Gift subscriptions/.test(x.textContent)));
  c.editEntry(id, 'category', 'resub');c.editEntry(id, 'lines', 'a reviewed return reaction');await c.refresh();renderMessages(view, c.getState(), c, at);
  assert.equal(view.entries.get(id).lines, card.lines);assert.equal(card.lines.value, 'a reviewed return reaction');assert.equal(card.category.value, 'resub');
  assert.match(card.help.textContent, /One eligible companion/);assert.equal(bankValidation(c.getState().bank), '');
});

test('144 event-aware groups save through the unchanged guarded bank endpoint and160 remains a hard limit', async () => {
  let data = saved(prepareEventBank(prepareStyleBank(defaultBank()).bank).bank), posts = [];
  const c = createDirectorController({ now: () => at, requestId: () => 'event-reviewed-save', fetchImpl: async (url, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body);posts.push({ url, body });data = { ...data, revision: 10, bank: body.bank, lastMutation: { requestId: body.requestId, revision: 10 } };return Response.json({ ok: true }); }
    return Response.json(data);
  } });
  await c.refresh();c.editEntry('event:fourth:gift', 'enabled', false);assert.equal(await c.saveBank(), true);
  assert.equal(posts.length, 1);assert.equal(posts[0].url, '/api/director/bank');assert.deepEqual(Object.keys(posts[0].body), ['requestId', 'expectedRevision', 'bank']);
  assert.equal(posts[0].body.bank.entries.length, 144);assert.equal(posts[0].body.expectedRevision, 9);validateBank(posts[0].body.bank);
  const oversized = structuredClone(data.bank);while (oversized.entries.length < 161) oversized.entries.push({ ...oversized.entries[0], id: `extra:${oversized.entries.length}` });
  assert.match(bankValidation(oversized), /160/);
});

test('event reaction timeline labels facts without converting them into a fabricated reply recipient', () => {
  const row = timelineRow(doc(), { kind: 'event', account: 'fixture_fourth', channel: 'fixture_channel', category: 'gift_batch', text: 'quite a batch of gifts.',
    at, delivery: 'confirmed', event: { id: 'gift:source-one', channel: 'fixture_channel', type: 'gift_batch', at: at - 1000 } });
  assert.match(row.textContent, /Event reaction/);assert.match(row.textContent, /Gift subscriptions together/);assert.doesNotMatch(row.textContent, /Reply to|undefined|source-one/);
});
