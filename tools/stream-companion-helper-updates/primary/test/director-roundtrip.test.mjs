import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../../stream-companion-host/lib/store.mjs';
import { createHostServer } from '../../stream-companion-host/server.mjs';
import { HostCoordinator } from '../lib/host-coordinator.mjs';
import { TwitchChat } from '../lib/twitch.mjs';
import { LocalControl } from '../lib/local-control.mjs';
import { DirectorAdapter } from '../lib/director-adapter.mjs';
import { importPages } from '../extension/director.js';

const clients = ['primary', 'test', 'third'].map((id, n) => ({ id, account: `personal_companion_${n}`, token: String(n + 1).repeat(48) }));
const channel = 'friend_channel', streamId = '123456789';
async function harness(t, hooks = {}) {
  let time = 1_800_000_000_000, calls = 0;
  const store = new HostStore({ file: ':memory:', clients, now: () => time, directorEnabled: true, random: () => 0 });
  const server = createHostServer({ store, clients, port: 0 }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'director-roundtrip-')), helpers = [], network = [];
  t.after(async () => { for (const h of helpers) h.coordinator.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const client of clients) {
    let twitch;
    const coordinator = new HostCoordinator({ config: { url: 'http://127.0.0.1:8795', clientId: client.id, account: client.account, token: client.token },
      outboxFile: join(directory, `${client.id}.json`), now: () => time, autoStart: false, testURL: `http://127.0.0.1:${server.address().port}`,
      getConnection: () => ({ channel: twitch.channel || '', connected: twitch.connected }),
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); network.push({ clientId: client.id, path: new URL(url).pathname, body });
        await hooks.before?.(url, body, { store, advance: ms => { time += ms; } });
        const response = await fetch(url, options);
        await hooks.after?.(url, body, { store, response });
        return response;
      } });
    twitch = new TwitchChat({ credentials: { account: client.account, userId: '123' }, coordinator, now: () => time });
    twitch.ensureIdentity = async () => {};
    twitch.inspectChannel = async () => ({ channel, checkedAt: time, streamContext: { channel, streamId, isLive: true,
      gameName: 'Minecraft', title: 'Own channel metadata', checkedAt: time }, sharedChat: false, chatSettings: {} });
    twitch.api = async (path, body) => {
      if (path.startsWith('shared_chat')) return { data: [] };
      assert.equal(path, 'chat/messages'); calls++;
      assert.equal(store.db.prepare('SELECT state FROM host_permits WHERE client_id=? ORDER BY at DESC').get(client.id).state, 'submitting');
      const planned = store.db.prepare('SELECT payload_json FROM director_plans WHERE client_id=? AND state=?').get(client.id, 'submitting');
      assert.equal(JSON.parse(planned.payload_json).text, body.message);
      return hooks.unknown ? { data: [] } : { data: [{ is_sent: true, message_id: `provider-${calls}` }] };
    };
    coordinator.seed([]);
    const control = new LocalControl({ twitch, now: () => time });
    control.rotate(true, 'initial-held');
    const sessionId = `browser-${client.id}`;
    const browser = armed => ({ settings: { revision: 1, allowedChannel: channel, paused: !armed, autoReply: armed,
      autoResume: false, chatMode: 'participate', replySource: 'local' },
      watch: { enabled: armed, channel, status: armed ? 'playing' : 'off', checkedAt: time } });
    const bind = () => ({ controlGeneration: control.generation, controlSessionId: sessionId, settingsRevision: 1 });
    control.bridge({ sessionId, controlGeneration: control.generation, state: browser(false) });
    const adapter = new DirectorAdapter({ twitch, control, config: {}, now: () => time });
    helpers.push({ twitch, coordinator, control, adapter, client, bind, browser, sessionId });
  }
  const migrate = async () => {
    for (const h of helpers) {
      for (const page of await importPages({ source: 'browser', account: h.client.account,
        preferences: { chatMode: 'participate', replySource: 'local' } })) await h.adapter.import({ ...h.bind(), page });
    }
  };
  const arm = async () => {
    for (const h of helpers) {
      h.control.stopped = false; h.twitch.connected = true; h.twitch.channel = channel; h.twitch.broadcasterId = '456';
      h.control.bridge({ sessionId: h.sessionId, controlGeneration: h.control.generation, state: h.browser(true) });
      await h.adapter.sync(h.bind());
    }
  };
  const send = async h => {
    const p = h.coordinator.directorState.plan;
    assert.ok(p, JSON.stringify(h.coordinator.directorState));
    const input = { ...h.bind(), account: p.account, channel: p.channel, text: p.text, category: p.category,
      kind: p.kind, streamId: p.streamId, participationKey: p.participationKey, replyTo: p.replyId, replyAuthor: p.replyAuthor,
      planId: p.planId, authorityEpoch: p.authorityEpoch, binding: p.binding, ...(p.exchangeId ? { exchangeId: p.exchangeId } : {}) };
    h.adapter.guardSend(input);
    return h.twitch.send({ ...input, beforeSubmit: () => h.adapter.guardSend(input) });
  };
  return { store, helpers, network, migrate, arm, send, calls: () => calls, directory };
}

test('all three held helpers migrate through authenticated real HTTP without connecting, arming or posting', async t => {
  const h = await harness(t); await h.migrate();
  assert.equal(h.store.director.ready, true); assert.equal(h.calls(), 0);
  assert.ok(h.helpers.every(x => x.control.stopped && !x.twitch.connected));
  assert.equal(h.network.some(x => /reserve|begin/.test(x.path)), false);
  for (const helper of h.helpers) {
    const outbox = JSON.parse(await readFile(join(h.directory, `${helper.client.id}.json`), 'utf8'));
    assert.equal(outbox.imports.helper.complete, true); assert.equal(outbox.imports.browser.complete, true);
  }
});
test('real central plan roundtrip preserves exact text, begins once and records one enriched canonical history row', async t => {
  const h = await harness(t); await h.migrate(); await h.arm();
  const first = h.helpers[0], p = first.coordinator.directorState.plan;
  assert.equal(p.kind, 'greeting');
  const result = await h.send(first); assert.equal(result.delivery, 'confirmed'); assert.equal(h.calls(), 1);
  const rows = h.store.db.prepare('SELECT * FROM director_history WHERE client_id=?').all(first.client.id);
  assert.equal(rows.length, 1); assert.equal(rows[0].text, p.text); assert.equal(rows[0].message_id, 'provider-1');
  assert.equal(h.store.status().channels[0].attemptsLastHour, 1);
  await first.twitch.refreshCoordination(first.coordinator.observation);
  assert.equal(h.store.status().channels[0].attemptsLastHour, 1);
});
test('a real lost begin response is certified no-send and releases its unused central attempt without a provider call', async t => {
  const h = await harness(t, { after: async url => { if (url.endsWith('/begin')) throw Error('lost begin response'); } });
  await h.migrate(); await h.arm();
  const result = await h.send(h.helpers[0]);
  assert.equal(result.delivery, 'cancelled'); assert.equal(result.submitted, false); assert.equal(h.calls(), 0);
  assert.equal(h.store.db.prepare('SELECT state FROM host_permits').get().state, 'cancelled');
  assert.equal(h.store.status().channels[0].attemptsLastHour, 0);
});
test('real uncertain delivery stays consumed centrally and cannot receive another send permit', async t => {
  const h = await harness(t, { unknown: true }); await h.migrate(); await h.arm();
  assert.equal((await h.send(h.helpers[0])).delivery, 'unknown');
  assert.equal(h.store.db.prepare('SELECT delivery FROM director_history').get().delivery, 'unknown');
  await h.helpers[0].adapter.sync(h.helpers[0].bind());
  assert.equal(h.helpers[0].coordinator.directorState.plan?.kind === 'greeting', false);
  assert.equal(h.calls(), 1);
});
