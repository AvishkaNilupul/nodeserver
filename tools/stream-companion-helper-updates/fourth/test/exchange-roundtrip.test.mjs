import { installDirectorFixture } from './director-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostCoordinator } from '../lib/host-coordinator.mjs';
import { TwitchChat } from '../lib/twitch.mjs';
import { messageKey } from '../extension/message-policy.js';
import { HostStore } from '../../stream-companion-host/lib/store.mjs';
import { createHostServer } from '../../stream-companion-host/server.mjs';

const clients = [{ id: 'primary', account: 'companion_test', token: 'a'.repeat(48) },
  { id: 'test', account: 'other_companion', token: 'b'.repeat(48) }];
const channel = 'friend_channel', streamId = '123456789';
async function harness(t, hooks = {}) {
  let time = 1_800_000_000_000;
  const store = new HostStore({ file: ':memory:', clients, now: () => time, random: () => 0 });
  const server = createHostServer({ store, clients, port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'companion-exchange-roundtrip-'));
  const helpers = [], requests = [], provider = [], saved = [[], []];
  for (const [i, client] of clients.entries()) {
    let twitch;
    const coordinator = new HostCoordinator({ config: { url: 'http://127.0.0.1:8795', clientId: client.id, account: client.account, token: client.token },
      outboxFile: join(directory, `${client.id}.json`), now: () => time, autoStart: false, testURL: `http://127.0.0.1:${server.address().port}`,
      getConnection: () => ({ channel: twitch.channel, connected: twitch.connected }),
      fetchImpl: async (url, options) => {
        requests.push({ clientId: client.id, path: new URL(url).pathname, body: JSON.parse(options.body) });
        if (url.endsWith('/begin')) assert.ok(saved[i].some(history => history.some(x => x.delivery === 'pending' && x.kind === 'exchange' && x.coordinationId)));
        const response = await fetch(url, options);
        if (url.endsWith('/begin')) await hooks.afterBegin?.({ twitch, store, now: time, advance: ms => { time += ms; } });
        return response;
      } });
    twitch = new TwitchChat({ credentials: { account: client.account, userId: String(123 + i) }, coordinator, now: () => time,
      saveHistory: async history => saved[i].push(structuredClone(history)) });
    installDirectorFixture(twitch);
    twitch.connected = true; twitch.channel = channel; twitch.broadcasterId = '456'; twitch.ensureIdentity = async () => {};
    twitch.inspectChannel = async () => ({ streamContext: { isLive: true, streamId }, sharedChat: false, chatSettings: {} });
    twitch.api = async (path, body) => {
      if (path.startsWith('shared_chat/')) return { data: [] };
      assert.equal(path, 'chat/messages');
      assert.equal(store.db.prepare('SELECT state FROM host_permits WHERE client_id=? ORDER BY at DESC').get(client.id).state, 'submitting');
      assert.match(body.message, /^@[a-z0-9_]{3,25} \S/);
      assert.equal(saved[i].at(-1).at(-1).text, body.message);
      assert.equal(store.db.prepare('SELECT text_key FROM host_permits WHERE client_id=? ORDER BY at DESC').get(client.id).text_key, messageKey(body.message));
      assert.equal('reply_parent_message_id' in body, false);
      provider.push({ account: client.account, body });
      return hooks.unknown ? { data: [] } : { data: [{ is_sent: true, message_id: `provider-${provider.length}` }] };
    };
    helpers.push({ twitch, coordinator, client });
  }
  t.after(async () => { for (const h of helpers) h.coordinator.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const refresh = async () => {
    for (const h of helpers) await h.twitch.refreshCoordination({ channel, paused: false, autoReply: true, chatMode: 'participate',
      exchangeContext: { streamId, checkedAt: time, lastHumanAt: h.twitch.messages.findLast(x => x.author === 'alice')?.at || 0 },
      playback: { enabled: true, channel, status: 'playing', checkedAt: time } });
  };
  const tick = async ms => { while (ms > 0) { const step = Math.min(ms, 30_000); time += step; ms -= step; await refresh(); } };
  const offers = () => helpers.flatMap(h => { const offer = h.coordinator.snapshot(channel).exchange; return offer ? [{ h, offer }] : []; });
  const send = ({ h, offer }) => h.twitch.send({ account: h.client.account, channel, streamId, text: offer.text,
    participationKey: offer.key, kind: 'exchange', exchangeId: offer.id });
  await refresh(); store.setExchangesEnabled(true);
  const next = Date.parse(store.status().exchanges.channels[0].nextAt);
  assert.equal(next - time, 60 * 60_000); assert.equal(offers().length, 0);
  await tick(next - time); await refresh();
  assert.equal(offers().length, 1, 'only the initiating account receives its due turn');
  return { store, helpers, provider, requests, offers, send, refresh, tick };
}

test('two real adapters complete only the exact scheduled plain two-line exchange', async t => {
  const h = await harness(t), first = h.offers()[0];
  assert.equal((await h.send(first)).delivery, 'confirmed');
  const request = h.requests.find(x => x.path === '/internal/reserve');
  assert.equal(request.body.exchangeId, first.offer.id); assert.equal(request.body.replyId, '');
  assert.equal(request.body.text, first.offer.text); assert.ok(request.body.planId); assert.ok(request.body.authorityEpoch); assert.equal('replyAt' in request.body, false);
  await h.refresh(); assert.equal(h.offers().length, 0);
  await h.tick(180_000); await h.refresh();
  const second = h.offers()[0]; assert.ok(second); assert.notEqual(second.h.client.account, first.h.client.account);
  assert.notEqual(second.offer.id, first.offer.id); assert.equal((await h.send(second)).delivery, 'confirmed');
  assert.equal(h.provider.length, 2); assert.equal(h.provider[0].body.message, first.offer.text);
  assert.equal(h.provider[1].body.message, second.offer.text);
  assert.equal(h.store.db.prepare('SELECT state FROM host_exchanges').get().state, 'completed');
  assert.equal(h.store.status().exchanges.channels[0].usedScenes, 1);
  await h.refresh(); assert.equal(h.offers().length, 0);
});

test('real host consumes an uncertain first line without scheduling or retrying its partner', async t => {
  const h = await harness(t, { unknown: true }), first = h.offers()[0];
  assert.equal((await h.send(first)).delivery, 'unknown');
  await h.tick(360_000); await h.refresh();
  assert.equal(h.provider.length, 1); assert.equal(h.offers().length, 0);
  assert.equal(h.store.db.prepare('SELECT state FROM host_exchanges').get().state, 'cancelled');
  assert.equal(h.store.status().exchanges.channels[0].usedScenes, 1);
  await assert.rejects(h.send(first), /no longer current/);
  assert.equal(h.provider.length, 1);
});

test('fresh human chat after real begin cancels the exchange permit and prevents its followup', async t => {
  const h = await harness(t, { afterBegin: ({ twitch, now }) => { twitch.messages = [{ id: 'new-human', author: 'alice', text: 'hello everyone', at: now }]; } });
  const result = await h.send(h.offers()[0]);
  assert.equal(result.suppressed, true); assert.equal(result.code, 'exchange_quiet'); assert.equal(result.submitted, false);
  assert.equal(h.provider.length, 0);
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'cancelled');
  assert.equal(h.store.status().channels[0].attemptsLastHour, 0);
  await h.tick(360_000); await h.refresh();
  assert.equal(h.offers().length, 0); assert.equal(h.provider.length, 0);
  assert.equal(h.store.db.prepare('SELECT state FROM host_exchanges').get().state, 'cancelled');
});
