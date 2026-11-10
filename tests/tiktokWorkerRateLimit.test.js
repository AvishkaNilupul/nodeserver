const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('authenticated TikTok traffic has a bounded bucket isolated from anonymous traffic', async () => {
  const old = { worker: process.env.TIKTOK_WORKER_KEY, setup: process.env.TIKTOK_SETUP_KEY };
  process.env.TIKTOK_WORKER_KEY = 'w'.repeat(40);
  process.env.TIKTOK_SETUP_KEY = 's'.repeat(40);
  const { globalLimiter } = require('../utils/rateLimit');
  const app = express();
  app.use(globalLimiter);
  app.use((_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const request = async (path, key, method = 'POST') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    await r.text();
    return r;
  };
  try {
    // An exhausted public bucket must not starve valid setup/phone traffic.
    for (let i = 0; i < 1000; i++) assert.equal((await request('/public')).status, 200);
    assert.equal((await request('/public')).status, 429);
    const worker = process.env.TIKTOK_WORKER_KEY, setup = process.env.TIKTOK_SETUP_KEY;
    for (const [path, key, method] of [
      ['/api/tiktok-farm/worker/poll', undefined, 'POST'],
      ['/api/tiktok-farm/worker/poll', 'wrong', 'POST'],
      ['/api/tiktok-farm/worker/setup/poll', worker, 'POST'],
      ['/api/tiktok-farm/worker/poll', setup, 'POST'],
      ['/api/tiktok-farm/worker/poll/extra', worker, 'POST'],
      ['/api/tiktok-farm/state', worker, 'POST'],
      ['/api/tiktok-farm/worker/poll', worker, 'GET'],
    ]) assert.equal((await request(path, key, method)).status, 429);
    const valid = [
      ['poll', worker], ['catalog', worker], ['update', worker], ['stock', worker],
      ['enrollment/poll', worker], ['enrollment/update', worker],
      ['setup/poll', setup], ['setup/update', setup], ['setup/session', setup], ['poll/', worker],
    ];
    for (const [path, key] of valid) {
      const r = await request('/api/tiktok-farm/worker/' + path, key);
      assert.equal(r.status, 200); assert.equal(r.headers.get('ratelimit-limit'), '600');
    }
    for (let i = valid.length; i < 600; i++)
      assert.equal((await request('/api/tiktok-farm/worker/poll', worker)).status, 200);
    assert.equal((await request('/api/tiktok-farm/worker/poll', worker)).status, 429);
    assert.equal((await request('/api/tiktok-farm/worker/setup/poll', setup)).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of [['TIKTOK_WORKER_KEY', old.worker], ['TIKTOK_SETUP_KEY', old.setup]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
