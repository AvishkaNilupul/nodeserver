import { randomUUID } from 'node:crypto';
import { detectHighlight } from './highlights.mjs';

const IDS = new Set(['primary', 'test']), LOGIN = /^[a-z0-9_]{3,25}$/, REQUEST = /^[A-Za-z0-9_:-]{1,160}$/;
const STATES = new Set(['queued', 'submitting', 'pending', 'confirmed', 'failed', 'cancelled', 'unknown']);
const TERMINAL = new Set(['confirmed', 'failed', 'cancelled']);
const COOLDOWN = 600_000, HOUR = 3_600_000;
const record = x => x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => record(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const stamp = x => typeof x === 'string' ? Date.parse(x) : x;
const text = (x, max = 300) => typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const selection = x => Array.isArray(x) && x.length > 0 && x.length <= 2 && x.every(id => IDS.has(id)) && new Set(x).size === x.length;

export function createClipController({ db, accounts, isPaused = () => true, now = Date.now,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, intervalMs = 5000, randomId = randomUUID } = {}) {
  if (!db || !accounts || !['snapshot', 'clipStatus', 'clipCreate', 'clipAuthorization'].every(k => typeof accounts[k] === 'function')) throw Error('Clip storage and account adapters required.');
  db.exec(`CREATE TABLE IF NOT EXISTS clip_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clip_jobs (request_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,account TEXT NOT NULL,
      channel TEXT NOT NULL,stream_id TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      state TEXT NOT NULL,clip_id TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',event_id TEXT NOT NULL DEFAULT '',evidence TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS clip_jobs_channel ON clip_jobs(channel,created_at);
    INSERT OR IGNORE INTO clip_settings VALUES (1,'{"enabled":false,"channel":"aviskarex","accountIds":["primary"]}');`);
  // A restored intent is reconciled by helper request ID, never submitted again.
  db.prepare("UPDATE clip_jobs SET state='unknown',updated_at=?,error='The host restarted before confirmation. Checking the helper; creation will not be retried.' WHERE state IN ('queued','submitting')").run(now());
  let settings = JSON.parse(db.prepare('SELECT value FROM clip_settings WHERE singleton=1').get().value);
  let epoch = 0, closed = false, timer = null, tickFlight = null, actionChain = Promise.resolve();
  const automaticPermits = new Set();
  let instances = [], helperStates = new Map(), feeds = new Map(), observation = null;
  const knownAccounts = new Set();
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companion_accounts'").get()) {
    for (const x of db.prepare('SELECT account FROM companion_accounts').all()) if (LOGIN.test(x.account || '')) knownAccounts.add(x.account);
  }
  let detector = { state: 'off', reason: 'Automatic clips are off.' }, updatedAt = now();
  const row = id => db.prepare('SELECT * FROM clip_jobs WHERE request_id=?').get(id);
  const rows = () => db.prepare('SELECT * FROM clip_jobs ORDER BY created_at DESC,rowid DESC LIMIT 50').all();
  const publicJob = x => ({ requestId: x.request_id, accountId: x.account_id, account: x.account, channel: x.channel,
    streamId: x.stream_id, source: x.source, createdAt: x.created_at, updatedAt: x.updated_at, state: x.state,
    clipId: x.clip_id, url: x.url, error: x.error, reason: x.reason });
  const saveState = (id, state, error = '') => db.prepare('UPDATE clip_jobs SET state=?,updated_at=?,error=? WHERE request_id=?').run(state, now(), text(error), id);
  const paused = () => { try { return isPaused() !== false; } catch { return true; } };
  const fresh = (value, age) => { const at = stamp(value); return Number.isFinite(at) && at > 0 && at <= now() && now() - at <= age; };
  const availableAccounts = () => ['primary', 'test'].map(id => {
    const a = instances.find(x => x.id === id), h = helperStates.get(id);
    return { id, account: LOGIN.test(h?.account || '') ? h.account : LOGIN.test(a?.account || '') ? a.account : '',
      available: a?.available === true && h?.available === true, authorized: h?.available === true && h.authorized === true,
      canAuthorize: a?.available === true && a.connected === false && a.settings?.paused === true
        && !(Array.isArray(a.controls?.pending) ? a.controls.pending.length : a.controls?.pending),
      error: text(h?.error || (!a?.available ? 'The companion is unavailable.' : '')) };
  });
  const snapshot = () => ({ ok: true, settings: { ...settings, accountIds: [...settings.accountIds] }, accounts: availableAccounts(),
    jobs: rows().map(publicJob), detector: { ...detector }, updatedAt: new Date(updatedAt).toISOString() });
  const resetObservation = () => { observation = null; feeds = new Map(); };
  const ensureOpen = () => { if (closed) throw fail('Clip controls are closed.', 503); };
  const configure = body => {
    ensureOpen();
    if (!exact(body, ['enabled', 'channel', 'accountIds']) || typeof body.enabled !== 'boolean' || !LOGIN.test(body.channel || '') || !selection(body.accountIds)) throw fail('Choose a channel, companion accounts and automatic clips setting.');
    const next = { enabled: body.enabled, channel: body.channel, accountIds: [...body.accountIds] };
    db.prepare('UPDATE clip_settings SET value=? WHERE singleton=1').run(JSON.stringify(next));
    settings = next; epoch++; automaticPermits.clear(); resetObservation(); updatedAt = now();
    detector = { state: next.enabled ? 'waiting' : 'off', reason: next.enabled ? 'Waiting for fresh live playback and chat.' : 'Automatic clips are off.' };
    return snapshot();
  };
  const gate = (id, channel, automatic) => {
    const a = instances.find(x => x.id === id), h = helperStates.get(id);
    if (!a?.available || !h?.available) return 'The selected companion is unavailable.';
    if (!a.authorized || !h.authorized || h.account !== a.account) return 'Enable clips for the selected companion first.';
    if (automatic && (paused() || a.coordination?.paused === true)) return 'Central coordination is paused.';
    if (automatic && (a.connected !== true || a.settings?.paused !== false || a.channel !== channel)) return 'The selected companion is held or disconnected.';
    if (!a.browser?.online || !fresh(a.browser.lastSeenAt, 45_000)) return 'Waiting for a fresh browser connection.';
    if (!a.watch?.enabled || a.watch.status !== 'playing' || a.watch.channel !== channel || !fresh(a.watch.checkedAt, 15_000)) return 'Waiting for fresh playing video on the selected channel.';
    const c = a.streamContext;
    if (!c?.isLive || c.channel !== channel || !/^\d{1,32}$/.test(c.streamId || '') || !fresh(c.checkedAt, 90_000)) return 'Waiting for the selected live stream to be verified.';
    if (a.settings?.allowedChannel && a.settings.allowedChannel !== channel) return 'The selected companion changed channel.';
    if (Array.isArray(a.controls?.pending) ? a.controls.pending.length : a.controls?.pending) return 'Waiting for the current companion command.';
    return '';
  };
  const updateFromHelper = (id, value) => {
    if (!record(value) || value.ok !== true || typeof value.authorized !== 'boolean' || !LOGIN.test(value.account || '') || !Array.isArray(value.jobs)) throw Error('The companion returned invalid clip status.');
    helperStates.set(id, { available: true, account: value.account, authorized: value.authorized, error: '' });
    knownAccounts.add(value.account);
    for (const job of value.jobs.slice(-100)) {
      if (!record(job) || !REQUEST.test(job.requestId || '') || !STATES.has(job.state)) continue;
      const old = row(job.requestId);
      if (!old || old.account_id !== id || old.account !== job.account || old.channel !== job.channel || old.stream_id !== job.streamId || old.source !== job.source || TERMINAL.has(old.state)) continue;
      const clipId = typeof job.clipId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(job.clipId) ? job.clipId : '';
      const url = clipId && job.url === `https://clips.twitch.tv/${clipId}` && job.state === 'confirmed' ? job.url : '';
      if (job.state === 'confirmed' && !url) continue;
      db.prepare('UPDATE clip_jobs SET state=?,updated_at=?,clip_id=?,url=?,error=? WHERE request_id=?').run(job.state, now(), clipId, url, text(job.error), old.request_id);
    }
  };
  const refresh = async () => {
    // These independent read calls share one timeout window, not three.
    const ids = ['primary', 'test'];
    const [accountResult, ...clipResults] = await Promise.allSettled([
      Promise.resolve().then(() => accounts.snapshot()), ...ids.map(id => Promise.resolve().then(() => accounts.clipStatus(id)))
    ]);
    const data = accountResult.status === 'fulfilled' ? accountResult.value : null;
    if (!record(data) || !Array.isArray(data.instances)) { instances = []; helperStates = new Map(); resetObservation(); throw fail('The companion status is unavailable.', 503); }
    instances = data.instances.filter(x => record(x) && IDS.has(x.id));
    for (const a of instances) if (LOGIN.test(a.account || '')) knownAccounts.add(a.account);
    ids.forEach((id, index) => {
      try { if (clipResults[index].status !== 'fulfilled') throw Error(); updateFromHelper(id, clipResults[index].value); }
      catch { helperStates.set(id, { available: false, authorized: false, error: 'The companion clip service is unavailable.' }); }
    });
    for (const x of db.prepare("SELECT * FROM clip_jobs WHERE state IN ('queued','submitting','pending') AND created_at<?").all(now() - 90_000)) saveState(x.request_id, 'unknown', 'Clip confirmation is unavailable. Creation will not be retried.');
    updatedAt = now();
  };
  const cooldown = channel => {
    const last = db.prepare("SELECT * FROM clip_jobs WHERE channel=? AND state<>'cancelled' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(channel);
    if (last && (['queued', 'submitting', 'pending'].includes(last.state) || now() - last.created_at < COOLDOWN)) return { job: last, reason: 'This channel already has a recent clip attempt. No duplicate was created.' };
    const hour = db.prepare("SELECT COUNT(*) AS count FROM clip_jobs WHERE channel=? AND state<>'cancelled' AND created_at>?").get(channel, now() - HOUR).count;
    if (hour >= 3) return { job: last, reason: 'This channel has reached three clip attempts in an hour.' };
    return null;
  };
  const serial = fn => { const work = actionChain.then(fn, fn); actionChain = work.catch(() => {}); return work; };
  const submit = async ({ requestId, channel, accountIds, source, event }, expectedEpoch) => {
    ensureOpen();
    const prior = row(requestId);
    if (prior) {
      if (prior.channel !== channel || prior.source !== source || !accountIds.includes(prior.account_id)) throw fail('This clip request ID was already used for another request.', 409);
      return { ok: true, job: publicJob(prior) };
    }
    await refresh();
    if (closed || expectedEpoch !== epoch) throw fail('Clip preparation was cancelled because the controls changed.', 409);
    const duplicate = cooldown(channel);
    if (duplicate) return { ok: true, job: { ...publicJob(duplicate.job), reason: duplicate.reason } };
    const accountId = accountIds.find(id => !gate(id, channel, source === 'automatic'));
    if (!accountId) throw fail(gate(accountIds[0], channel, source === 'automatic'), 409);
    const a = instances.find(x => x.id === accountId), streamId = a.streamContext.streamId;
    if (event && (event.streamId !== streamId || event.triggerAt < now() - 20_000 || event.triggerAt > now())) throw fail('The detected moment is no longer current.', 409);
    // SQLite commits before the helper receives any creation request.
    db.prepare('INSERT INTO clip_jobs(request_id,account_id,account,channel,stream_id,source,created_at,updated_at,state,reason,event_id,evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(requestId, accountId, a.account, channel, streamId, source, now(), now(), 'submitting', event ? 'Chat reaction detected' : 'Manual clip request', event?.eventId || '', JSON.stringify(event?.evidence || {}));
    if (source === 'automatic') {
      for (const id of automaticPermits) { const previous = row(id); if (!previous || now() - previous.created_at > 60_000) automaticPermits.delete(id); }
      automaticPermits.add(requestId);
    }
    try {
      // No async gap is permitted between the final controls check and dispatch.
      if (closed || expectedEpoch !== epoch || gate(accountId, channel, source === 'automatic')) { saveState(requestId, 'cancelled', 'Clip preparation was cancelled.'); return { ok: true, job: publicJob(row(requestId)) }; }
      const result = await accounts.clipCreate(accountId, { requestId, channel, streamId, source });
      if (!record(result) || result.ok !== true || !record(result.job) || result.job.requestId !== requestId) throw Error('Unconfirmed helper response.');
      updateFromHelper(accountId, { ok: true, account: a.account, authorized: true, jobs: [result.job] });
      if (row(requestId).state === 'submitting') saveState(requestId, 'unknown', 'The companion did not confirm the clip job. Creation will not be retried.');
    } catch (e) {
      saveState(requestId, [400, 403, 409, 429].includes(e?.status) ? 'failed' : 'unknown', [400, 403, 409, 429].includes(e?.status) ? 'The companion rejected the clip request.' : 'The clip request outcome is unconfirmed. Creation will not be retried.');
    }
    db.exec('DELETE FROM clip_jobs WHERE request_id NOT IN (SELECT request_id FROM clip_jobs ORDER BY created_at DESC,rowid DESC LIMIT 500)');
    updatedAt = now(); return { ok: true, job: publicJob(row(requestId)) };
  };
  const create = body => {
    ensureOpen();
    if (!exact(body, ['requestId', 'channel', 'accountIds']) || !REQUEST.test(body.requestId || '') || !LOGIN.test(body.channel || '') || !selection(body.accountIds)) throw fail('Choose a channel and companion accounts for this clip.');
    const copy = { requestId: body.requestId, channel: body.channel, accountIds: [...body.accountIds], source: 'manual' }, expected = epoch;
    return serial(() => submit(copy, expected));
  };
  const authorize = body => {
    ensureOpen();
    if (!exact(body, ['accountId', 'action']) || !IDS.has(body.accountId) || !['start', 'poll'].includes(body.action)) throw fail('Choose a companion clip authorization action.');
    const input = { accountId: body.accountId, action: body.action };
    return serial(async () => {
    ensureOpen();
    const body = input;
    if (body.action === 'start') {
      await refresh(); ensureOpen();
      const a = instances.find(x => x.id === body.accountId);
      if (!a?.available || a.connected !== false || a.settings?.paused !== true
        || (Array.isArray(a.controls?.pending) ? a.controls.pending.length : a.controls?.pending)) throw fail('Hold and disconnect this companion before enabling clips.', 409);
      epoch++; automaticPermits.clear(); resetObservation();
    }
    const raw = await accounts.clipAuthorization(body.accountId, { action: body.action });
    if (!record(raw) || raw.ok !== true) throw fail('The companion did not confirm clip authorization.', 503);
    const result = { ok: true };
    for (const key of ['verificationUrl', 'userCode', 'account']) if (typeof raw?.[key] === 'string') result[key] = text(raw[key], key === 'verificationUrl' ? 200 : 80);
    if (result.verificationUrl && result.verificationUrl !== 'https://www.twitch.tv/activate') throw fail('The companion returned an invalid Twitch activation page.', 503);
    for (const key of ['pollAfterMs', 'expiresAt']) if (Number.isFinite(raw?.[key]) && raw[key] >= 0) result[key] = raw[key];
    for (const key of ['pending', 'authorized']) if (typeof raw?.[key] === 'boolean') result[key] = raw[key];
    return result;
    });
  };
  const tick = () => {
    if (closed) return Promise.resolve(snapshot());
    if (tickFlight) return tickFlight;
    const expected = epoch;
    tickFlight = serial(async () => {
      try {
        await refresh();
        if (closed || expected !== epoch) return snapshot();
        if (!settings.enabled || paused()) { resetObservation(); detector = { state: settings.enabled ? 'held' : 'off', reason: settings.enabled ? 'Central coordination is paused.' : 'Automatic clips are off.' }; return snapshot(); }
        const candidates = settings.accountIds.filter(id => !gate(id, settings.channel, true));
        if (!candidates.length) { resetObservation(); detector = { state: 'waiting', reason: gate(settings.accountIds[0], settings.channel, true) }; return snapshot(); }
        const feed = candidates.map(id => instances.find(x => x.id === id)), streamId = feed[0].streamContext.streamId;
        const same = feed.filter(a => a.streamContext.streamId === streamId), key = `${settings.channel}:${streamId}:${same.map(a => a.id).sort().join(',')}`;
        if (observation?.key !== key) { resetObservation(); observation = { key, since: now(), baselineSince: now() }; }
        const excludedAuthors = [...knownAccounts];
        for (const a of same) for (const m of a.chat?.messages || []) if (record(m) && typeof m.id === 'string' && Number.isFinite(m.at) && m.at >= observation.since && m.at <= now()) feeds.set(m.id, m);
        for (const [id, m] of feeds) if (m.at < now() - 180_000) feeds.delete(id);
        if (feeds.size > 1000) {
          feeds = new Map([...feeds].sort((a,b) => b[1].at - a[1].at).slice(0, 1000));
          observation.baselineSince = Math.max(observation.baselineSince, Math.min(...[...feeds.values()].map(m => m.at)));
        }
        const recent = cooldown(settings.channel);
        if (recent) { detector = { state: 'cooldown', reason: recent.reason }; return snapshot(); }
        if (now() - observation.since < 90_000) { detector = { state: 'warming', reason: 'Observing fresh chat for 90 seconds before detecting reactions.' }; return snapshot(); }
        const event = detectHighlight({ messages: [...feeds.values()], excludedAuthors, channel: settings.channel, streamId,
          observedSince: observation.since, baselineSince: observation.baselineSince, now: now() });
        if (!event) { detector = { state: 'watching', reason: 'Watching for a distinct burst of chat reactions.' }; return snapshot(); }
        const result = await submit({ requestId: `auto:${randomId()}`, channel: settings.channel, accountIds: candidates, source: 'automatic', event }, expected);
        detector = { state: 'cooldown', reason: result.job.state === 'cancelled' ? 'The detected moment was cancelled.' : 'Chat reaction detected' };
      } catch (e) { resetObservation(); detector = { state: 'unavailable', reason: e?.status ? text(e.message) : 'Clip status is unavailable. Automatic creation is held.' }; }
      updatedAt = now(); return snapshot();
    }).finally(() => { tickFlight = null; });
    return tickFlight;
  };
  const start = () => { ensureOpen(); if (!timer) { timer = setIntervalImpl(() => { void tick().catch(() => {}); }, intervalMs); timer?.unref?.(); void tick().catch(() => {}); } return snapshot(); };
  let closeFlight;
  const close = () => {
    if (closeFlight) return closeFlight;
    closed = true; epoch++; automaticPermits.clear(); if (timer) clearIntervalImpl(timer); timer = null; resetObservation();
    // Already dispatched work must finish journaling before the owning DB closes.
    closeFlight = actionChain.catch(() => {}).then(() => undefined);
    return closeFlight;
  };
  const permit = (clientId, body) => {
    ensureOpen();
    if (!IDS.has(clientId) || !exact(body, ['requestId']) || !REQUEST.test(body.requestId || '')) throw fail('Invalid clip permission request.');
    const job = row(body.requestId);
    const allowed = automaticPermits.has(body.requestId) && job?.account_id === clientId && job.source === 'automatic'
      && settings.enabled && settings.channel === job.channel && settings.accountIds.includes(clientId)
      && instances.some(a => a.id === clientId && a.account === job.account && a.streamContext?.streamId === job.stream_id)
      && !paused() && now() >= job.created_at && now() - job.created_at <= 60_000
      && ['queued', 'submitting', 'unknown'].includes(job.state) && !gate(clientId, job.channel, true);
    if (job?.account_id === clientId) automaticPermits.delete(body.requestId);
    return { ok: allowed === true, reason: allowed ? '' : 'Automatic clip settings or session changed. This moment is held.' };
  };
  return { snapshot, configure, create, authorize, tick, start, close, permit };
}
