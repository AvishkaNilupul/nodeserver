import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostCoordinator } from '../lib/host-coordinator.mjs';
import { TwitchChat } from '../lib/twitch.mjs';
import { HostStore } from '../../stream-companion-host/lib/store.mjs';
import { createHostServer } from '../../stream-companion-host/server.mjs';

const clients = [{ id: 'primary', account: 'companion_test', token: 'a'.repeat(48) },
  { id: 'test', account: 'other_companion', token: 'b'.repeat(48) }];
const channel = 'friend_channel';
async function harness(t, hooks = {}) {
  let time = 1_800_000_000_000;
  const store = new HostStore({ file: ':memory:', clients, now: () => time });
  const server = createHostServer({ store, clients, port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'companion-host-roundtrip-'));
  const outboxFile = join(directory, 'completions.json'); const saved = [], network = []; let providerCalls = 0, twitch;
  const coordinator = new HostCoordinator({ config: { url: 'http://127.0.0.1:8795', clientId: 'primary', account: 'companion_test', token: clients[0].token },
    outboxFile, now: () => time, autoStart: false, testURL: `http://127.0.0.1:${server.address().port}`,
    getConnection: () => ({ channel: twitch.channel, connected: twitch.connected }),
    fetchImpl: async (url, options) => {
      network.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
      if (url.endsWith('/begin')) assert.ok(saved.some(history => history.some(x => x.delivery === 'pending' && x.coordinationId)), 'helper intent must persist before central begin');
      if (hooks.before) await hooks.before(url, options, { store, advance: ms => { time += ms; } });
      const response = await fetch(url, options);
      network.at(-1).status = response.status; network.at(-1).response = await response.clone().json();
      if (hooks.after) await hooks.after(url, response, { store });
      return response;
    } });
  twitch = new TwitchChat({ credentials: { account: 'companion_test', userId: '123' }, coordinator, now: () => time,
    saveHistory: async history => saved.push(structuredClone(history)) });
  twitch.connected = true; twitch.channel = channel; twitch.broadcasterId = '456'; twitch.ensureIdentity = async () => {};
  twitch.inspectChannel = async () => ({ streamContext: { isLive: true, streamId: '123456789' }, sharedChat: false, chatSettings: {} });
  twitch.api = async (path, body) => {
    if (path.startsWith('shared_chat/')) return { data: [] };
    if (path !== 'chat/messages') throw Error('Unexpected provider route');
    providerCalls++; assert.equal(store.status().channels[0].activeSpeaker, 'companion_test');
    assert.equal(store.db.prepare("SELECT state FROM host_permits WHERE client_id='primary'").get().state, 'submitting');
    return { data: [{ is_sent: true, message_id: 'confirmed-provider-id' }] };
  };
  const observation = () => ({ channel, paused: false, autoReply: true,
    playback: { enabled: true, channel, status: 'playing', checkedAt: time } });
  t.after(async () => { coordinator.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  await twitch.refreshCoordination(observation());
  assert.equal(coordinator.snapshot(channel).available, true, JSON.stringify(network));
  const send = () => twitch.send({ account: 'companion_test', channel, text: 'hello everyone', kind: 'greeting', streamId: '123456789', participationKey: 'companion_test:friend_channel:123456789:greeting' });
  return { store, coordinator, twitch, send, observation, saved, network, outboxFile, providerCalls: () => providerCalls };
}

test('real adapter/host roundtrip persists intent, begins once, confirms and seeds idempotently', async t => {
  const h = await harness(t); const sent = await h.send();
  assert.equal(sent.delivery, 'confirmed'); assert.equal(h.providerCalls(), 1);
  assert.equal(h.store.status().channels[0].attemptsLastHour, 1);
  await h.twitch.refreshCoordination(h.observation());
  assert.equal(h.store.status().channels[0].attemptsLastHour, 1, 'own history seed cannot count the same coordinationId twice');
  assert.deepEqual(JSON.parse(await readFile(h.outboxFile, 'utf8')).pending, []);
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'confirmed');
  const routes = h.network.map(x => x.path); assert.ok(routes.indexOf('/internal/reserve') < routes.indexOf('/internal/begin'));
});

test('lost begin response cancels the real host submitting permit without a Twitch request', async t => {
  const h = await harness(t, { after: async url => { if (url.endsWith('/begin')) throw Error('lost response after host accepted begin'); } });
  const result = await h.send();
  assert.equal(result.suppressed, true); assert.equal(result.submitted, false); assert.equal(h.providerCalls(), 0);
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'cancelled');
  assert.equal(h.store.status().channels[0].attemptsLastHour, 0);
  assert.equal(h.network.find(x => x.path === '/internal/finish').body.submitted, false);
});

test('completion outage preserves known delivery; sync history reconciles it and outbox replay drains', async t => {
  let failFinish = true;
  const h = await harness(t, { before: async url => { if (failFinish && url.endsWith('/finish')) throw Error('completion route offline'); } });
  assert.equal((await h.send()).delivery, 'confirmed'); assert.equal(h.providerCalls(), 1);
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'submitting');
  assert.equal(JSON.parse(await readFile(h.outboxFile, 'utf8')).pending.length, 1);
  await h.twitch.refreshCoordination(h.observation());
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'confirmed', 'own confirmed coordinationId seed reconciles a lost completion');
  failFinish = false; await h.coordinator.flush();
  assert.deepEqual(JSON.parse(await readFile(h.outboxFile, 'utf8')).pending, []);
  assert.equal(h.providerCalls(), 1); assert.equal(h.store.status().channels[0].attemptsLastHour, 1);
});

test('real host rechecks stale playback at begin and helper cancels the unused turn', async t => {
  const h = await harness(t, { before: async (url, _options, context) => { if (url.endsWith('/begin')) context.advance(45001); } });
  const result = await h.send(); assert.equal(result.suppressed, true); assert.equal(h.providerCalls(), 0);
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'cancelled');
  assert.equal(h.store.status().channels[0].attemptsLastHour, 0);
});
