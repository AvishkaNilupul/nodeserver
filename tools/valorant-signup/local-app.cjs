const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {LocalVault} = require('../epic-signup/local-vault.cjs');
const {createMail} = require('./mail.cjs');
const {countries, cleanCountry, expectedShard, prepareProxy, browserLocation} = require('./regions.cjs');
const DEFAULT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ValorantAccountGenerator');

function createApp({dataDir = DEFAULT_DIR, port = 4110, mail = createMail(), prepare = prepareProxy} = {}) {
  const app = express(), vault = new LocalVault(dataDir), tickets = new Map();
  const token = crypto.randomBytes(32).toString('base64url');
  let starting = false, preparing = false;
  const active = () => vault.data.sessions.find(s => !['created', 'cancelled'].includes(s.status));
  const meta = s => ({id: s.id, email: s.email, username: s.username, requestedCountry: s.requestedCountry,
    proxyCountry: s.creationLocation.country, expectedShard: s.expectedShard, country: s.country,
    shard: s.shard, regionVerified: false, status: s.status, createdAt: s.createdAt,
    completedAt: s.completedAt, mailPending: !!s.mailPending, stage: s.stage || 'reserved'});
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.get('host'))) return res.sendStatus(403);
    const origin = req.get('origin');
    const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '');
    if (origin && !extension && !['http://127.0.0.1:' + port, 'http://localhost:' + port].includes(origin)) return res.sendStatus(403);
    if (req.get('sec-fetch-site') === 'cross-site' && !extension) return res.sendStatus(403);
    res.set({'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
    next();
  });
  app.use(express.json({limit: '8kb'}));
  const auth = (req,res,next) => {
    const value = req.get('X-Local-Token');
    return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) &&
      crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token)) ? next() : res.sendStatus(403);
  };
  function consume(body) {
    const proxy = tickets.get(body.ticket);
    if (!proxy) throw Error('Test the regional proxy again');
    const location = browserLocation(body.browserLocation, proxy);
    cleanCountry(location.country); tickets.delete(body.ticket);
    return {proxy, location};
  }
  app.get('/health', (_req,res) => res.json({ok: true, service: 'valorant-signup'}));
  app.get('/', (_req,res) => res.type('html').send(fs.readFileSync(path.join(__dirname, 'local.html'), 'utf8').replace('__TOKEN__', token)));
  for (const filename of ['ui.js', 'style.css']) app.get('/' + filename, (_req,res) => res.sendFile(path.join(__dirname, filename)));
  app.get('/api/regions', auth, (_req,res) => res.json({ok: true, countries}));
  app.get('/api/state', auth, async (_req,res,next) => {
    try {
      let pool; try {pool = await mail.status();} catch {pool = {error: 'Cloud Outlook is unavailable', exclusiveReady: false};}
      res.json({ok: true, pool, active: active() ? meta(active()) : null, accounts: vault.data.accounts.map(meta)});
    } catch (e) {next(e);}
  });
  app.post('/api/proxy/prepare', auth, async (req,res,next) => {
    if (preparing) return res.status(409).json({ok: false, error: 'A proxy check is already running'});
    preparing = true;
    try {
      const country = cleanCountry(req.body.country), proxy = await prepare(country);
      for (const [id,p] of tickets) if (Date.parse(p.expiresAt) <= Date.now()) tickets.delete(id);
      if (tickets.size >= 8) tickets.delete(tickets.keys().next().value);
      const ticket = crypto.randomUUID(); tickets.set(ticket, proxy);
      res.json({ok: true, ticket, proxy});
    } catch (e) {next(e);} finally {preparing = false;}
  });
  app.post('/api/start', auth, async (req,res,next) => {
    if (starting || active()) return res.status(409).json({ok: false, error: 'Resume the existing signup first'});
    starting = true;
    try {
      const {proxy, location} = consume(req.body);
      const id = crypto.randomUUID();
      const identity = {id, username: 'v' + crypto.randomBytes(9).toString('hex'),
        password: crypto.randomBytes(15).toString('base64url') + '!7aA',
        birthDate: `${1990 + crypto.randomInt(0,12)}-${String(crypto.randomInt(1,13)).padStart(2,'0')}-${String(crypto.randomInt(1,29)).padStart(2,'0')}`,
        requestedCountry: location.country, expectedShard: expectedShard(location.country), country: null,
        shard: null, creationLocation: location, proxy, status: 'reserved', stage: 'reserved', createdAt: new Date().toISOString()};
      // A failed/abandoned signup keeps its exclusive inbox and identity.
      identity.email = await mail.reserve();
      vault.data.sessions.push(identity); vault.save();
      res.json({ok: true, session: identity});
    } catch (e) {next(e);} finally {starting = false;}
  });
  app.post('/api/resume', auth, (req,res,next) => {
    const session = active();
    if (!session) return res.status(404).json({ok: false, error: 'No interrupted signup'});
    try {
      const {proxy, location} = consume(req.body);
      if (location.country !== session.requestedCountry) throw Error('Resume must use the original signup country');
      session.proxy = proxy; session.lastResumeLocation = location;
      session.lastResumedAt = new Date().toISOString(); vault.save();
      res.json({ok: true, session});
    } catch (e) {next(e);}
  });
  app.post('/api/session/:id/stage', auth, (req,res) => {
    const s = active(); if (!s || s.id !== req.params.id) return res.sendStatus(404);
    if (!['email', 'birthdate', 'username', 'password', 'terms', 'verification', 'submitted', 'challenge', 'needs-action', 'failed'].includes(req.body.stage)) return res.sendStatus(400);
    s.stage = req.body.stage; vault.save(); res.json({ok: true});
  });
  app.post('/api/session/:id/verification', auth, async (req,res,next) => {
    const s = active(); if (!s || s.id !== req.params.id) return res.sendStatus(404);
    try {res.json({ok: true, code: await mail.verify(s)});} catch (e) {next(e);}
  });
  app.post('/api/session/:id/complete', auth, async (req,res,next) => {
    const s = vault.data.sessions.find(s => s.id === req.params.id);
    if (!s) return res.sendStatus(404);
    try {
      if (s.status !== 'created') {
        // Extension observed Riot's signup/verification response, never a guessed
        // success URL, filled form, request dispatch, or HTTP 200 alone.
        if (req.body.evidence?.source !== 'riot-signup-response' || req.body.evidence?.type !== 'success' ||
            req.body.evidence?.username !== s.username) return res.sendStatus(400);
        s.status = 'created'; s.stage = 'created'; s.completedAt = new Date().toISOString(); s.mailPending = true;
        const {proxy, ...account} = s;
        vault.data.accounts.push({...account, source: 'extension', product: 'fresh-riot-account',
          level: null, rankedReady: false, regionVerified: false});
        vault.save();
      }
      if (s.mailPending) {
        await mail.complete(s); s.mailPending = false;
        vault.data.accounts.find(a => a.id === s.id).mailPending = false; vault.save();
      }
      res.json({ok: true});
    } catch (e) {next(e);}
  });
  app.post('/api/accounts/:id/retry-mail', auth, async (req,res,next) => {
    const s = vault.data.sessions.find(s => s.id === req.params.id && s.status === 'created');
    if (!s) return res.sendStatus(404);
    try {await mail.complete(s); s.mailPending = false;
      vault.data.accounts.find(a => a.id === s.id).mailPending = false; vault.save(); res.json({ok: true});
    } catch (e) {next(e);}
  });
  app.post('/api/accounts/:id/reveal', auth, (req,res) => {
    const a = vault.data.accounts.find(a => a.id === req.params.id);
    if (!a) return res.sendStatus(404);
    res.json({ok: true, username: a.username, email: a.email, password: a.password, birthDate: a.birthDate});
  });
  app.use((err,_req,res,_next) => res.status(503).json({ok: false,
    error: /^(Choose a supported|Test the regional|Browser proxy|Resume must|The proxy exit|Cloud Outlook needs)/.test(err.message) ? err.message : 'Signup operation failed. Resume the same signup; its inbox stays reserved.'}));
  return {app, vault, token};
}
if (require.main === module) createApp().app.listen(4110, '127.0.0.1', () => console.log('Valorant creator: http://127.0.0.1:4110'));
module.exports = {createApp, DEFAULT_DIR};
