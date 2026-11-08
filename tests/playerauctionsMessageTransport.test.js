const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Load the real transport with isolated credentials and no possible network IO.
function transport(respond) {
  const filename = path.resolve(__dirname, '../utils/marketplaces.js');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = (name) => {
    if (name === 'axios') return respond;
    if (name === './settings') return {
      loadSettings: () => ({ marketplaces: { playerauctions: { cookie: 'test=fixture' } } }),
      saveSettings: () => { throw new Error('Unexpected settings write'); },
    };
    return original(name);
  };
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return mod.exports;
}

test('PA order messages use multipart fields accepted by the current API', async () => {
  const text = 'Login: fixture / password\nUse the instructions & keep + punctuation.';
  let calls = 0;
  const mp = transport(async (request) => {
    calls++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, 'https://user-api.playerauctions.com/api/messages');
    assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.equal(request.headers['Content-Type'], undefined);
    const boundary = request.data.getBoundary();
    assert(request.headers['content-type'].endsWith(boundary));
    const body = request.data.getBuffer().toString();
    for (const [name, value] of Object.entries({ objectIdType: 'Order', objectId: '12345678', content: text })) {
      assert(body.includes(`name="${name}"\r\n\r\n${value}\r\n`), `${name} missing or altered`);
    }
    return { data: { isSuccess: true, data: { accepted: true } }, headers: {} };
  });
  assert.deepEqual(await mp.playerauctionsSendOrderMessage('12345678', text), { accepted: true });
  assert.equal(calls, 1);
});

test('PA message validation errors cannot be treated as delivery success', async () => {
  const mp = transport(async () => ({
    data: { isSuccess: false, code: 400, message: 'The Content field is required.' }, headers: {},
  }));
  await assert.rejects(mp.playerauctionsSendOrderMessage('12345678', 'fixture'), /Content field is required/);
});

test('PA overlength messages are refused before any network call', async () => {
  const mp = transport(async () => { assert.fail('Unexpected network call'); });
  await assert.rejects(mp.playerauctionsSendOrderMessage('12345678', 'x'.repeat(301)), /300-char limit/);
});
