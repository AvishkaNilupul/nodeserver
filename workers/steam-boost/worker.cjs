// Assignment-driven Steam worker. Only loopback HTTP through the SSH tunnel.
const { AccountBooster } = require('./booster.cjs');
const { verifiedCountryProxy } = require('./proxy.cjs');
const { setTimeout: delay } = require('node:timers/promises');

function createApi({ base = process.env.BOOST_API_URL, token = process.env.STEAM_BOOST_WORKER_TOKEN, fetchImpl = fetch } = {}) {
  const url = new URL(base || 'http://127.0.0.1:18130/boost-worker/v1/');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw Error('Worker API must use the loopback SSH tunnel');
  if (!token || token.length < 32) throw Error('Worker token missing');
  return async (path, body) => {
    const r = await fetchImpl(new URL(path, url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw Error('Worker API returned HTTP ' + r.status);
    const data = await r.json();
    if (!data.ok) throw Error('Worker API refused request');
    return data;
  };
}

class Worker {
  constructor({ api, makeBooster = o => new AccountBooster(o), proxy = verifiedCountryProxy, now = Date.now, sleep = ms => delay(ms), blindMs = 180000, loginGapMs = 20000, log = () => {} } = {}) {
    this.api = api; this.makeBooster = makeBooster; this.proxy = proxy; this.now = now; this.sleep = sleep;
    this.blindMs = blindMs; this.loginGapMs = loginGapMs;
    this.log = log;
    this.sessions = new Map(); this.lastAssignments = now(); this.lastLogin = 0; this.running = true;
  }
  async startOne(a) {
    const call = (path, fields = {}) => this.api(path, { ...fields, id: a.id, gen: a.gen });
    const row = { assignment: a, started: this.now(), nextSettle: null, resumeAt: 0, failed: false };
    const account = { id: a.id, username: a.accountName, country: a.country, password: '', email: '' };
    const booster = this.makeBooster({ account, games: a.games, licensed: a.licensed, proxy: this.proxy,
      // steam-user must not persist machine/login secrets on the worker disk.
      dataDirectory: null,
      tokens: {
        get: async () => { const login = await call('login'); account.password = login.password; return login.refreshToken || null; },
        set: (_id, refreshToken) => call('token', { refreshToken }),
        clear: () => call('token/clear'),
      },
      guardMail: { waitForCode: async (_email, since, { exclude } = {}) => {
        const deadline = this.now() + 240000;
        while (this.running && booster.running && this.now() < deadline) {
          const hit = await call('guard-code', { since, exclude });
          if (hit.code) return hit;
          await this.sleep(10000);
        }
        throw Error('Steam Guard wait ended');
      } },
      log: () => {},
    });
    row.booster = booster;
    booster.on('failed', () => { row.failed = true; });
    // Time the first full window from actual play, after proxy/login/license work.
    booster.on('state', state => {
      // Account IDs and states only; never log credentials, Guard or proxy details.
      this.log(`[steam-boost] account=${a.id} state=${state}`);
      if (['connecting', 'reconnecting', 'retrying'].includes(state)) {
        row.nextSettle = null; row.resumeAt = 0;
        booster.resume(); // discard any interrupted settlement pause
      }
      if (state === 'playing' && row.nextSettle === null) row.nextSettle = this.now() + 20 * 60000;
    });
    this.sessions.set(a.id, row);
    booster.start();
    this.lastLogin = this.now();
  }
  async drop(id) {
    const row = this.sessions.get(id);
    if (!row) return;
    await row.booster.stop();
    this.sessions.delete(id);
  }
  async reconcile() {
    let response;
    try { response = await this.api('assignments'); this.lastAssignments = this.now(); }
    catch (e) {
      if (this.now() - this.lastAssignments >= this.blindMs) for (const id of [...this.sessions.keys()]) await this.drop(id);
      throw e;
    }
    const desired = new Map(response.accounts.map(a => [a.id, a]));
    for (const [id, row] of this.sessions) {
      const next = desired.get(id);
      if (!next || next.gen !== row.assignment.gen) await this.drop(id);
    }
    for (const tombstone of response.stopping || []) {
      await this.drop(tombstone.id);
      // No session in this process remains; the previous container/process is
      // stopped before a replacement instance is launched by deployment.
      await this.api('report', { accounts: [{ ...tombstone, stopped: true }], worker: { version: '2', note: 'logout acknowledged' } });
    }
    for (const a of response.accounts) {
      if (!this.running || this.now() - this.lastLogin < this.loginGapMs) break;
      if (!this.sessions.has(a.id)) { await this.startOne(a); break; }
    }
  }
  async report() {
    const accounts = [];
    for (const row of this.sessions.values()) {
      const b = row.booster;
      const now = this.now();
      if (b.running && b.steamID && b.ready) {
        if (row.resumeAt && now >= row.resumeAt) {
          await b.refreshPlaytime(); b.resume(); row.resumeAt = 0;
          row.nextSettle = now + (row.assignment.purpose === 'game' ? 20 * 60000 : 7200000);
        } else if (!row.resumeAt && row.nextSettle !== null && now >= row.nextSettle) {
          b.pause(); row.resumeAt = now + 90000;
        }
      }
      accounts.push({ ...b.status(), id: row.assignment.id, gen: row.assignment.gen, licensed: [...b.licensed], failed: row.failed });
    }
    await this.api('report', { worker: { version: '2', note: accounts.length + ' account(s) assigned' }, accounts });
  }
  async cycle() { await this.reconcile(); await this.report(); }
  async stop() { this.running = false; for (const id of [...this.sessions.keys()]) await this.drop(id); }
}

async function main() {
  const worker = new Worker({ api: createApi(), log: line => console.log(line) });
  const quit = async () => { await worker.stop(); process.exit(0); };
  process.on('SIGTERM', quit); process.on('SIGINT', quit);
  while (worker.running) {
    try { await worker.cycle(); }
    catch { console.error('[steam-boost] API or Steam read failed; retrying'); }
    await delay(15000);
  }
}
if (require.main === module) main().catch(() => { console.error('[steam-boost] startup failed'); process.exit(1); });
module.exports = { Worker, createApi };
