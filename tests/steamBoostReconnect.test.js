const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const SteamUser = require('../workers/steam-boost/node_modules/steam-user');
const { AccountBooster } = require('../workers/steam-boost/booster.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let now = 0, id = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) { const key = ++id; pending.set(key, { fn, at: now + ms }); return key; },
    clearTimeout(key) { pending.delete(key); },
    setInterval() { return ++id; }, clearInterval() {},
  };
  return { timers, async advance(ms) {
    const until = now + ms;
    for (;;) {
      const next = [...pending].sort((a,b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      now = next[1].at; pending.delete(next[0]); next[1].fn(); await tick();
    }
    now = until; await tick();
  } };
}
class Client extends EventEmitter {
  constructor(options) { super(); this.options = options; this.logins = []; this.logoffs = 0; this.played = []; }
  logOn(details) { this.logins.push(details); }
  logOff() { this.logoffs++; this.emit('disconnected', 0, 'logged off'); }
  gamesPlayed(games) { this.played.push(games); }
  getUserOwnedApps(_id, _options, cb) { cb(null, { apps: [{ appid: 730, playtime_forever: 60 }] }); }
  login() { this.steamID = { getSteamID64: () => '76561190000000001' }; this.emit('loggedOn'); }
}
function setup(over = {}) {
  const time = clock(), clients = [], proxies = [], saved = [];
  const booster = new AccountBooster({
    account: { id: 'a', username: 'u', password: 'pw', country: 'JP' }, games: [730],
    tokens: { get: async () => 'saved-token', set: async (_id, token) => saved.push(token), clear: async () => {} },
    proxy: async country => { proxies.push(country); return { url: `http://proxy-${proxies.length}`, location: { country } }; },
    timers: time.timers,
    createClient: options => { const client = new Client(options); clients.push(client); return client; },
    ...over,
  });
  return { booster, clients, proxies, saved, ...time };
}
async function playing(s) { s.booster.start(); await tick(); s.clients[0].login(); await tick(); assert.equal(s.booster.state, 'playing'); }

test('stalled reconnect replaces client and proxy, then resumes real games', async () => {
  const s = setup(); await playing(s); const old = s.clients[0];
  old.emit('disconnected', 3, 'lost transport');
  assert.deepEqual(s.booster.playing, []);
  await s.advance(120000); assert.equal(s.booster.state, 'retrying'); assert.equal(old.logoffs, 1);
  await s.advance(30000); assert.equal(s.clients.length, 2); assert.equal(s.proxies.length, 2);
  assert.notEqual(s.clients[1].options.httpProxy, old.options.httpProxy);
  assert.equal(s.clients[1].logins.length, 1);
  s.clients[1].login(); await tick();
  assert.equal(s.booster.state, 'playing'); assert.deepEqual(s.booster.playing, [730]);
  await s.advance(300000); assert.equal(s.clients.length, 2);
});
test('short automatic reconnect cancels recovery deadline without another login', async () => {
  const s = setup(); await playing(s);
  s.clients[0].emit('disconnected', 3); await s.advance(60000);
  s.clients[0].login(); await tick(); await s.advance(300000);
  assert.equal(s.booster.state, 'playing'); assert.equal(s.clients.length, 1);
});
test('silent initial login cannot loop forever inside steam-user', async () => {
  const s = setup(); s.booster.start(); await tick();
  await s.advance(300000); assert.equal(s.booster.state, 'retrying');
  assert.equal(s.booster.lastError, 'Steam login timed out');
  await s.advance(30000); assert.equal(s.clients.length, 2);
});
test('stalled library setup is retired and its late result cannot start playing', async () => {
  const s = setup(); s.booster.start(); await tick(); let answer;
  s.clients[0].getUserOwnedApps = (_id, _opts, cb) => { answer = cb; };
  s.clients[0].login(); await s.advance(120000); await s.advance(30000);
  answer(null, { apps: [{ appid: 730 }] }); await tick();
  assert.equal(s.booster.state, 'connecting'); assert.deepEqual(s.booster.playing, []);
});
test('retired client events cannot overwrite token, fail, or block replacement', async () => {
  const s = setup(); await playing(s); const old = s.clients[0];
  old.emit('disconnected', 3); await s.advance(150000);
  s.clients[1].login(); await tick();
  old.emit('refreshToken', 'obsolete'); old.emit('playingState', true, 730);
  old.emit('error', { eresult: SteamUser.EResult.InvalidPassword }); old.login();
  await tick(); assert.equal(s.booster.state, 'playing'); assert.deepEqual(s.saved, []);
  assert.equal(s.booster.blocked, false); assert.deepEqual(s.booster.playing, [730]);
});
test('stop during reconnect cancels watchdog and any further login', async () => {
  const s = setup(); await playing(s); s.clients[0].emit('disconnected', 3);
  await s.booster.stop(); await s.advance(3600000);
  assert.equal(s.booster.state, 'stopped'); assert.equal(s.clients.length, 1);
  assert.equal(s.booster.steamID, null); assert.deepEqual(s.booster.playing, []);
});
test('Steam throttling keeps its full cooldown after watchdog cancellation', async () => {
  const s = setup(); s.booster.start(); await tick();
  s.clients[0].emit('error', { eresult: SteamUser.EResult.RateLimitExceeded });
  await s.advance(35 * 60000 - 1); assert.equal(s.clients.length, 1);
  await s.advance(1); assert.equal(s.clients.length, 2);
});
test('late proxy failure from timed-out attempt cannot interrupt its replacement', async () => {
  const pending = deferred(); let calls = 0;
  const s = setup({ proxy: async country => ++calls === 1 ? pending.promise : { url: 'http://fresh', location: { country } } });
  s.booster.start(); await s.advance(330000);
  s.clients[0].login(); await tick(); pending.reject(Error('old proxy failed')); await tick();
  assert.equal(s.booster.state, 'playing'); assert.equal(s.booster.lastError, null);
});
test('repeated disconnect notices cannot postpone recovery indefinitely', async () => {
  const s = setup(); await playing(s);
  s.clients[0].emit('disconnected', 3); await s.advance(60000);
  s.clients[0].emit('disconnected', 3); await s.advance(60000);
  assert.equal(s.booster.state, 'retrying');
});
