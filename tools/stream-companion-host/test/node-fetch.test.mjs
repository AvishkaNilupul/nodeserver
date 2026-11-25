import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostServer } from '../server.mjs';
import { HostStore } from '../lib/store.mjs';

test('real Node fetch can synchronize despite its automatic sec-fetch-mode header', async t => {
  const clients = [{ id: 'primary', account: 'first_account', name: 'First', token: 'fetch-test-client-token-not-a-real-credential' }];
  const store = new HostStore({ file: ':memory:', clients });
  const server = createHostServer({ store, clients, port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/internal/sync`;
  const headers = { 'Content-Type': 'application/json',
    Authorization: `Bearer ${clients[0].token}`, 'X-Companion-Id': 'primary' };
  const body = JSON.stringify({ channel: 'friend_channel', connected: true, ready: true,
    playback: { status: 'playing', checkedAt: Date.now() }, seed: [] });
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).snapshot.available, true);
  const browser = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body,
    signal: AbortSignal.timeout(2000) });
  assert.equal(browser.status, 403);
});
