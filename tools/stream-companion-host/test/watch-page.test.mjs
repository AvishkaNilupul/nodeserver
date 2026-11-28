import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHostServer, REMOTE_PREFIX } from '../server.mjs';
import { watchUrl } from '../public/watch.js';

test('only an ordinary channel login can opt this tab into watch quality', () => {
  assert.equal(watchUrl(' Viewer_5 '), 'https://www.twitch.tv/viewer_5#companion-watch');
  for (const invalid of ['', 'a', 'a'.repeat(26), 'example.com', 'foo/bar', 'foo?x=y', 'foo#anchor', 'directory', 'SeTTings', 'foo\nbar']) {
    assert.equal(watchUrl(invalid), '', invalid);
  }
});

test('the local watch launcher works independently of any account pairing and stays off the remote mount', async t => {
  const client = { id: 'primary', account: 'test_channel', token: 'p'.repeat(48) };
  const store = { client: () => client };
  const token = 'r'.repeat(48);
  const accounts = { snapshot() { assert.fail('Reading watch launcher should never contact a helper.'); } };
  const server = createHostServer({ store, accounts, clients: [client], remoteToken: token, port: 0 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/watch', '/watch.js']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal((await fetch(origin + REMOTE_PREFIX + path, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(origin + path, { method: 'POST' })).status, 405);
  }
  const html = await (await fetch(origin + '/watch')).text();
  assert.match(html, /id="watch-channel-form"/);
  assert.match(html, /src="\/watch\.js"/);
  assert.doesNotMatch(html, /src="\/(?:accounts|messages|clips)\.js"/);
});
