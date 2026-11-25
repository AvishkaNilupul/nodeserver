import { basePathFromModule, controllerBasePath, controllerPath, requestNetwork, networkTitle, bindControllerLifecycle } from './controller-path.js';

const IDS = ['primary', 'test', 'third'];
const CREATORS = Object.freeze({ primary: ['primary'], test: ['test'], third: ['third'], both: ['primary', 'test'], 'primary-third': ['primary', 'third'], 'test-third': ['test', 'third'], all: ['primary', 'test', 'third'] });
const CREATOR_LABELS = { primary: 'Main account', test: 'Second account', third: 'Third account', both: 'Main + second', 'primary-third': 'Main + third', 'test-third': 'Second + third', all: 'All three' };
const accountLabel = id => CREATOR_LABELS[id] || 'Account';
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const LOGIN = /^[a-z0-9_]{3,25}$/;
const array = value => Array.isArray(value) ? value : [];
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = value => Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const text = (value, max = 400) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const creatorIds = selection => [...(CREATORS[selection] || [])];
const selectionFor = ids => Object.keys(CREATORS).find(key => CREATORS[key].length === ids.length && CREATORS[key].every(id => ids.includes(id))) || '';

export function clipUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'clips.twitch.tv' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && /^\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}
export function clipAuthorizationUrl(value, expectedUserCode) {
  if (typeof value !== 'string' || value.length > 512 || !/^https:\/\/www\.twitch\.tv\/activate(?:\?|$)/.test(value)
    || /[\u0000-\u0020\u007f\\#]/.test(value)
    || expectedUserCode !== undefined && (typeof expectedUserCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(expectedUserCode))) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'www.twitch.tv' || url.pathname !== '/activate'
      || url.port || url.username || url.password || url.hash) return '';
    const seen = new Set();
    for (const [key, entry] of url.searchParams) {
      if (seen.has(key) || !['public', 'device-code'].includes(key)) return '';
      seen.add(key);
      if (key === 'public' && entry !== 'true' || key === 'device-code'
        && (!/^[A-Za-z0-9-]{4,32}$/.test(entry) || expectedUserCode !== undefined && entry !== expectedUserCode)) return '';
    }
    if (!seen.size) url.search = '';
    return url.href;
  } catch { return ''; }
}

export function createClipsController({ fetchImpl = globalThis.fetch, now = Date.now, requestId = () => globalThis.crypto.randomUUID(),
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout, onState = () => {}, basePath = '' } = {}) {
  basePath = controllerBasePath(basePath);
  const state = { basePath, network: 'loading', data: null, receivedAt: 0, busy: '', error: '', feedback: '',
    form: { channel: 'aviskarex', selection: 'primary', enabled: false, dirty: false, revision: 0 }, authorizations: {} };
  let flight = null, timer = null, revision = 0, stopped = false;
  const authTimers = new Map(), authVersions = new Map();
  const emit = () => onState(state);
  const account = id => array(state.data?.accounts).find(value => value?.id === id);
  const fresh = () => state.network === 'online' && state.receivedAt > 0 && now() >= state.receivedAt && now() - state.receivedAt <= 15000
    && Number.isFinite(stamp(state.data?.updatedAt)) && stamp(state.data.updatedAt) <= now() + 5000 && stamp(state.data.updatedAt) >= now() - 20000;
  const canMutate = () => fresh() && !state.busy && TOKEN.test(state.data?.csrfToken || '');
  const validForm = () => LOGIN.test(state.form.channel) && creatorIds(state.form.selection).length > 0;
  const canCreate = () => canMutate() && validForm() && creatorIds(state.form.selection).some(id => account(id)?.available === true && account(id)?.authorized === true);
  const canAuthorize = id => canMutate() && IDS.includes(id) && account(id)?.available === true && account(id)?.canAuthorize === true && account(id)?.authorized !== true;
  const cancelAuthTimer = id => { if (authTimers.has(id)) clearTimeoutImpl(authTimers.get(id)); authTimers.delete(id); };
  async function refresh() {
    if (flight) return flight;
    const expected = revision;
    flight = (async () => {
      try {
        const response = await fetchImpl(controllerPath(basePath, '/api/clips'), { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw Object.assign(Error('Unavailable'), { status: response.status });
        const data = await response.json();
        if (!object(data) || data.ok !== true || !object(data.settings) || !Array.isArray(data.accounts) || !Array.isArray(data.jobs)
          || !Number.isFinite(stamp(data.updatedAt))) throw Error('Invalid clip status');
        if (expected !== revision) return;
        state.data = data; state.receivedAt = now(); state.network = stamp(data.updatedAt) < now() - 20000 || stamp(data.updatedAt) > now() + 5000 ? 'stale' : 'online';
        if (!state.form.dirty) {
          if (LOGIN.test(data.settings.channel || '')) state.form.channel = data.settings.channel;
          const ids = array(data.settings.accountIds);
          if (ids.length && new Set(ids).size === ids.length && ids.every(id => IDS.includes(id))) state.form.selection = selectionFor(ids);
          state.form.enabled = data.settings.enabled === true;
        }
        for (const id of IDS) {
          const auth = state.authorizations[id];
          if (account(id)?.authorized === true && auth) {
            auth.pending = false; auth.authorized = true; cancelAuthTimer(id);
          } else if (auth?.pending && now() >= auth.expiresAt) {
            auth.pending = false; auth.error = 'This approval code expired. Enable clips again for a new code.'; cancelAuthTimer(id);
          }
        }
      } catch (error) { if (expected === revision) state.network = requestNetwork(error); }
      finally { emit(); }
    })().finally(() => { flight = null; });
    return flight;
  }
  function edit(key, value) {
    if (key === 'channel') state.form.channel = String(value).trim().toLowerCase();
    else if (key === 'selection' && Object.hasOwn(CREATORS, value)) state.form.selection = value;
    else if (key === 'enabled' && typeof value === 'boolean') state.form.enabled = value;
    else return;
    state.form.dirty = true; state.form.revision++; emit();
  }
  async function mutate(path, body, action, outcome = {}) {
    outcome.kind = 'blocked';
    if (!canMutate()) { state.error = 'Wait for fresh clip status before using these controls.'; emit(); return null; }
    // Finish any preceding read, so it cannot replace settings after a write.
    if (flight) await flight;
    if (!canMutate()) return null;
    revision++; state.busy = action; state.error = ''; state.feedback = ''; outcome.kind = 'uncertain'; emit();
    let result = null;
    try {
      const response = await fetchImpl(controllerPath(basePath, path), { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.data.csrfToken }, body: JSON.stringify(body) });
      const definitive = response.status >= 400 && response.status < 500;
      let value; try { value = await response.json(); } catch { if (!definitive) throw Error('Unconfirmed'); }
      if (response.status >= 500) throw Error('Unconfirmed');
      if (!response.ok || value?.ok !== true) {
        outcome.kind = definitive ? 'definitive' : 'uncertain';
        state.error = [401, 403].includes(response.status) ? 'Refresh the controller and check your sign-in and two-factor access.' : text(value?.error) || 'The clip action was not accepted.';
        if ([401, 403].includes(response.status)) state.network = requestNetwork({ status: response.status });
      } else { outcome.kind = 'success'; result = value; }
    } catch { outcome.kind = 'uncertain'; state.error = 'The outcome is unconfirmed. Refresh clips to check the recorded result. This request will not be retried automatically.'; }
    finally { state.busy = ''; state.receivedAt = 0; emit(); }
    await refresh();
    return result;
  }
  async function save() {
    if (!validForm()) { state.error = 'Enter a channel login with 3–25 letters, numbers or underscores.'; emit(); return false; }
    const formRevision = state.form.revision;
    const result = await mutate('/api/clips/settings', { enabled: state.form.enabled, channel: state.form.channel, accountIds: creatorIds(state.form.selection) }, 'settings');
    if (result) { if (formRevision === state.form.revision) state.form.dirty = false; state.feedback = 'Clip settings saved.'; emit(); return true; }
    return false;
  }
  async function create() {
    if (!canCreate()) { state.error = 'Choose a channel and an account with clip permission, then wait for fresh status.'; emit(); return false; }
    const result = await mutate('/api/clips/create', { requestId: requestId(), channel: state.form.channel, accountIds: creatorIds(state.form.selection) }, 'create');
    if (result) { state.feedback = result.job?.state === 'confirmed' ? 'The clip is ready below.' : 'Clip request recorded. Twitch may take up to a minute to confirm it.'; emit(); return true; }
    return false;
  }
  function scheduleAuthorization(id, generation) {
    cancelAuthTimer(id);
    const auth = state.authorizations[id];
    if (stopped || !auth?.pending || authVersions.get(id) !== generation) return;
    if (now() >= auth.expiresAt) { auth.pending = false; auth.error = 'This approval code expired. Enable clips again for a new code.'; emit(); return; }
    authTimers.set(id, setTimeoutImpl(() => {
      authTimers.delete(id);
      if (stopped || authVersions.get(id) !== generation) return;
      if (!fresh()) { auth.error = 'Refresh clips, then use Check approval to continue.'; emit(); return; }
      if (state.busy) { scheduleAuthorization(id, generation); return; }
      void authorize(id, 'poll', generation);
    }, Math.max(5000, Math.min(60000, auth.pollAfterMs || 5000))));
  }
  async function authorize(id, action = 'start', expectedGeneration) {
    if (!IDS.includes(id) || !['start', 'poll'].includes(action)) return false;
    if (action === 'start' && !canAuthorize(id)) { state.error = 'Stop this account first and wait for fresh status before enabling clips.'; emit(); return false; }
    if (action === 'poll' && !state.authorizations[id]?.pending) return false;
    if (action === 'poll' && now() >= state.authorizations[id].expiresAt) {
      state.authorizations[id].pending = false; state.authorizations[id].error = 'This approval code expired. Enable clips again for a new code.'; cancelAuthTimer(id); emit(); return false;
    }
    let generation = expectedGeneration;
    if (generation === undefined) { generation = (authVersions.get(id) || 0) + 1; authVersions.set(id, generation); }
    cancelAuthTimer(id);
    const outcome = {};
    const result = await mutate('/api/clips/authorization', { accountId: id, action }, `authorize-${id}`, outcome);
    if (authVersions.get(id) !== generation) return false;
    if (!result) {
      if (outcome.kind === 'definitive') {
        state.authorizations[id] = { authorized: false, pending: false, error: state.error || 'Approval was not completed. Enable clips to try again.' };
      } else if (state.authorizations[id]) state.authorizations[id].error = 'Approval was not confirmed. Refresh clips and use Check approval to continue.';
      emit(); return false;
    }
    const previous = state.authorizations[id] || {};
    if (result.authorized === true) {
      state.authorizations[id] = { ...previous, authorized: true, pending: false, error: '' };
      state.feedback = 'Clip permission granted. The account stays stopped until you start it.';
    } else {
      const freshCode = Object.hasOwn(result, 'userCode'), freshUrl = Object.hasOwn(result, 'verificationUrl');
      const userCode = freshCode ? /^[A-Za-z0-9-]{4,32}$/.test(result.userCode || '') ? result.userCode : '' : previous.userCode || '';
      const verificationUrl = userCode ? clipAuthorizationUrl(freshUrl ? result.verificationUrl : previous.verificationUrl, userCode) : '';
      if (freshCode && !userCode || freshUrl && (!userCode || !verificationUrl)) {
        state.error = 'Twitch returned invalid approval details. Enable clips again.';
        state.authorizations[id] = { authorized: false, pending: false, error: state.error }; emit(); return false;
      }
      if ((!verificationUrl || !userCode) && result.pending !== true) { state.error = 'Twitch did not return a usable approval code. Enable clips again.'; emit(); return false; }
      const expires = stamp(result.expiresAt);
      state.authorizations[id] = { verificationUrl, userCode, authorized: false, pending: true,
        pollAfterMs: Number.isFinite(result.pollAfterMs) ? result.pollAfterMs : 5000,
        expiresAt: Number.isFinite(expires) && expires > now() ? Math.min(expires, now() + 900000) : previous.expiresAt || now() + 900000, error: '' };
      scheduleAuthorization(id, generation);
    }
    emit(); return true;
  }
  function start() { stopped = false; if (timer === null) timer = setIntervalImpl(() => { emit(); void refresh(); }, 5000); void refresh(); }
  function stop() { stopped = true; if (timer !== null) clearIntervalImpl(timer); timer = null; for (const id of IDS) cancelAuthTimer(id); }
  return { getState: () => state, refresh, edit, save, create, authorize, start, stop, fresh, canMutate, canCreate, canAuthorize };
}

export function createClipsView(document) {
  const ids = ['clips-network', 'clips-channel', 'clips-accounts', 'clips-create', 'clips-refresh', 'clips-enabled', 'clips-save', 'clips-saved', 'clips-detector', 'clips-feedback', 'clips-error', 'clips-history',
    ...IDS.flatMap(id => [`clips-name-${id}`, `clips-permission-${id}`, `clips-enable-${id}`, `clips-auth-${id}`, `clips-check-${id}`])];
  const nodes = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const el = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };
  return { nodes, el, signatures: {} };
}
const jobState = value => ({ queued: 'Preparing', submitting: 'Creating clip', pending: 'Confirming with Twitch', confirmed: 'Clip ready', failed: 'Not created', cancelled: 'Cancelled', unknown: 'Unconfirmed' })[value] || 'Unconfirmed';
export function renderClips(view, state, { now = Date.now(), canMutate = () => false, canCreate = () => false, canAuthorize = () => false } = {}) {
  const n = view.nodes, data = state.data, form = state.form;
  n['clips-network'].textContent = networkTitle(state.network, state.basePath);
  if (n['clips-channel'].value !== form.channel) n['clips-channel'].value = form.channel;
  if (n['clips-accounts'].value !== form.selection) n['clips-accounts'].value = form.selection;
  n['clips-enabled'].checked = form.enabled;
  n['clips-create'].disabled = !canCreate(); n['clips-save'].disabled = !canMutate();
  n['clips-create'].textContent = state.busy === 'create' ? 'Recording clip…' : 'Clip moment';
  n['clips-save'].textContent = state.busy === 'settings' ? 'Saving…' : 'Save clip settings';
  n['clips-saved'].textContent = form.dirty ? 'Unsaved clip settings.' : data ? `${data.settings?.enabled ? 'Auto clips on' : 'Auto clips off'} · #${text(data.settings?.channel, 25)} · ${CREATOR_LABELS[selectionFor(array(data.settings?.accountIds))] || 'Unverified selection'}` : 'Waiting for clip settings.';
  n['clips-detector'].textContent = state.network !== 'online' ? 'Detector status is unverified until the controller reconnects.' : text(data?.detector?.reason) || 'Waiting for detector status.';
  n['clips-feedback'].textContent = state.feedback; n['clips-feedback'].hidden = !state.feedback;
  n['clips-error'].textContent = state.error || (state.network === 'offline' ? 'The clip controller is unavailable. Showing last reported values; no request will be replayed.' : ''); n['clips-error'].hidden = !n['clips-error'].textContent;
  for (const id of IDS) {
    const account = array(data?.accounts).find(value => value?.id === id), auth = state.authorizations[id];
    n[`clips-name-${id}`].textContent = account?.account ? `@${text(account.account, 25)}` : accountLabel(id);
    n[`clips-permission-${id}`].textContent = state.network !== 'online' ? 'Permission status unverified.' : account?.authorized ? 'Clip permission granted.' : account?.available !== true ? 'Account helper unavailable.' : account?.canAuthorize ? 'Clip permission required. Ready to enable.' : 'Stop this account before enabling clips.';
    n[`clips-enable-${id}`].disabled = !canAuthorize(id) || auth?.pending === true;
    n[`clips-enable-${id}`].textContent = state.busy === `authorize-${id}` ? 'Checking Twitch…' : account?.authorized ? 'Clips enabled' : 'Enable clips';
    const authNode = n[`clips-auth-${id}`]; authNode.hidden = !auth;
    const authSignature = JSON.stringify(auth || null);
    if (view.signatures[id] !== authSignature) {
      view.signatures[id] = authSignature;
      const parts = [];
      if (auth?.authorized) parts.push(view.el('p', 'Twitch approved clip creation. This account remains stopped.'));
      else if (auth && !auth.pending) {
        parts.push(view.el('p', 'Approval was not completed. Enable clips to request a new code.'));
        if (auth.error) parts.push(view.el('p', text(auth.error)));
      } else if (auth) {
        if (auth.userCode && clipAuthorizationUrl(auth.verificationUrl, auth.userCode)) {
          parts.push(view.el('p', `Approve clip creation for ${account?.account ? `@${text(account.account, 25)}` : accountLabel(id).toLowerCase()} on Twitch using this code:`));
          parts.push(view.el('code', text(auth.userCode, 32)));
        } else parts.push(view.el('p', 'Preparing Twitch approval details…'));
        const url = clipAuthorizationUrl(auth.verificationUrl, auth.userCode);
        if (url) { const link = view.el('a', 'Open Twitch approval'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; const line = view.el('p'); line.append(link); parts.push(line); }
        if (auth.pending && auth.userCode) parts.push(view.el('p', 'Waiting for Twitch approval. Approve using this same account.'));
        if (auth.error) parts.push(view.el('p', text(auth.error)));
      }
      authNode.replaceChildren(...parts);
    }
    n[`clips-check-${id}`].hidden = !auth?.pending; n[`clips-check-${id}`].disabled = !canMutate();
  }
  const jobs = array(data?.jobs).slice(0, 50), jobsSignature = JSON.stringify(jobs);
  if (view.signatures.jobs !== jobsSignature) {
    view.signatures.jobs = jobsSignature;
    const rows = jobs.map(job => {
      const row = view.el('li'), heading = view.el('div', undefined, 'clips-job-title');
      heading.append(view.el('strong', `#${text(job.channel, 25) || 'channel'}`), view.el('span', jobState(job.state), 'pill'));
      row.append(heading);
      const at = stamp(job.createdAt), time = Number.isFinite(at) ? new Date(at).toLocaleString() : 'Time unavailable';
      row.append(view.el('p', `${job.account ? `@${text(job.account, 25)}` : accountLabel(job.accountId)} · ${job.source === 'automatic' ? 'Chat reaction detected' : 'Clip moment'} · ${time}`, 'clips-job-meta'));
      if (job.reason) row.append(view.el('p', text(job.reason), 'clips-job-meta'));
      if (job.error) row.append(view.el('p', text(job.error), 'clips-job-meta'));
      if (job.state === 'unknown') row.append(view.el('p', 'Twitch has not confirmed the outcome. This clip will not be created again automatically.', 'clips-job-meta'));
      const url = job.state === 'confirmed' ? clipUrl(job.url) : '';
      if (url) { const link = view.el('a', 'Open clip', 'clips-job-link'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
      return row;
    });
    n['clips-history'].replaceChildren(...(rows.length ? rows : [view.el('li', 'No clips recorded yet.', 'empty')]));
  }
}

if (globalThis.document?.querySelector('[data-clips-app]')) {
  const basePath = basePathFromModule(import.meta.url), document = globalThis.document, view = createClipsView(document);
  const controller = createClipsController({ basePath, onState: state => renderClips(view, state, { canMutate: controller.canMutate, canCreate: controller.canCreate, canAuthorize: controller.canAuthorize }) });
  const n = view.nodes;
  n['clips-channel'].addEventListener('input', () => controller.edit('channel', n['clips-channel'].value));
  n['clips-accounts'].addEventListener('change', () => controller.edit('selection', n['clips-accounts'].value));
  n['clips-enabled'].addEventListener('change', () => controller.edit('enabled', n['clips-enabled'].checked));
  n['clips-create'].addEventListener('click', () => void controller.create());
  n['clips-save'].addEventListener('click', () => void controller.save());
  n['clips-refresh'].addEventListener('click', () => void controller.refresh());
  for (const id of IDS) {
    n[`clips-enable-${id}`].addEventListener('click', () => void controller.authorize(id));
    n[`clips-check-${id}`].addEventListener('click', () => void controller.authorize(id, 'poll'));
  }
  bindControllerLifecycle(controller); controller.start();
}
