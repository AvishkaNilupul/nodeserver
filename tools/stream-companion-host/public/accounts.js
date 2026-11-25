import { controllerBasePath, basePathFromModule, controllerPath, responseError, requestNetwork, networkTitle, connectionMessage, configureControllerMount, bindControllerLifecycle } from './controller-path.js';

const POLL_MS = 2500;
const HOST_FRESH_MS = 10000;
const BRIDGE_FRESH_MS = 45000;
const IDS = new Set(['primary', 'test']);
const ACTIONS = new Set(['start', 'stop', 'watch', 'settings', 'draft', 'send', 'drops-enable', 'drops-disable', 'drops-check']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);
const ACTION_LABELS = { start: 'Start companion', stop: 'Stop companion', watch: 'Open stream', settings: 'Save settings', draft: 'Create draft', send: 'Send reviewed message', 'drops-enable': 'Enable drop claims', 'drops-disable': 'Disable drop claims', 'drops-check': 'Check drops' };
const STATE_LABELS = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired', submitting: 'Submitting', unknown: 'Awaiting outcome' };
const text = (value, fallback = '—') => typeof value === 'string' && value ? value : fallback;
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const label = (map, key, fallback) => Object.hasOwn(map, key ?? '') ? map[key] : fallback;
export const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, limit, now) => { const at = timestamp(value); return Number.isFinite(at) && at > 0 && now - at <= limit && at - now <= 5000; };
export function age(value, now = Date.now()) {
  const at = timestamp(value);
  if (!Number.isFinite(at) || at <= 0) return 'Not checked';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function accountFromPath(pathname, basePath = '') {
  const base = controllerBasePath(basePath);
  if (typeof pathname !== 'string' || base && !pathname.startsWith(`${base}/`)) return null;
  const match = /^\/accounts\/(primary|test)\/?$/.exec(pathname.slice(base.length));
  return match ? match[1] : null;
}
function hostFresh(state, now) { return state.network === 'online' && fresh(state.data?.updatedAt, HOST_FRESH_MS, now); }
export function bridgeFresh(instance, now = Date.now()) { return instance?.available === true && instance.browser?.online === true && fresh(instance.browser?.lastSeenAt, BRIDGE_FRESH_MS, now); }
function instanceFor(state, id) { return list(state.data?.instances).find(instance => instance?.id === id); }
function active(command, now) { return command && !TERMINAL.has(command.state) && (!command.expiresAt || timestamp(command.expiresAt) > now); }
function validChannel(value) { return typeof value === 'string' && /^[a-zA-Z0-9_]{3,25}$/.test(value); }
function validMessage(value) { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 300 && !/^[/.]|[\r\n\u0000-\u001f\u007f]|https?:\/\/|www\./i.test(value); }
function validMode(value) { return value === 'mentions' || value === 'participate'; }
function validSource(value) { return value === 'local' || value === 'ai'; }
function commandParams(action, params = {}) {
  if (action === 'start' && validChannel(params.channel) && validMode(params.chatMode) && validSource(params.replySource) && typeof params.autoResume === 'boolean') return { channel: params.channel.toLowerCase(), chatMode: params.chatMode, replySource: params.replySource, autoResume: params.autoResume };
  if (action === 'settings' && validMode(params.chatMode) && validSource(params.replySource) && typeof params.autoResume === 'boolean') return { chatMode: params.chatMode, replySource: params.replySource, autoResume: params.autoResume };
  if (action === 'draft' && ['reply', 'summary'].includes(params.mode)) return { mode: params.mode };
  if (action === 'send' && validMessage(params.text)) return { text: params.text };
  if (['stop', 'watch', 'drops-enable', 'drops-disable', 'drops-check'].includes(action)) return {};
  return null;
}

export function createAccountsController({ fetchImpl = globalThis.fetch, now = Date.now, onState = () => {}, requestId = () => globalThis.crypto.randomUUID(), setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval, basePath = '' } = {}) {
  basePath = controllerBasePath(basePath);
  const state = { basePath, data: null, network: 'loading', error: '', operations: {}, forms: {} };
  let flight = null, timer = null;
  const emit = () => onState(state);
  const formFor = id => state.forms[id] ||= { initialized: false, channel: '', chatMode: 'mentions', replySource: 'local', autoResume: false, text: '', textRevision: 0, dirty: {} };
  function reconcile() {
    for (const instance of list(state.data?.instances)) {
      if (!IDS.has(instance?.id)) continue;
      const form = formFor(instance.id), settings = instance.settings || {};
      for (const [key, value] of Object.entries(instance.settings ? { channel: settings.allowedChannel || instance.channel || '', chatMode: validMode(settings.chatMode) ? settings.chatMode : 'mentions', replySource: validSource(settings.replySource) ? settings.replySource : 'local', autoResume: settings.autoResume === true } : {})) {
        if (!form.dirty[key]) form[key] = value;
      }
      form.initialized ||= !!instance.settings;
      const operation = state.operations[instance.id];
      if (!operation) continue;
      const match = [instance.controls?.pending, ...list(instance.controls?.recent)].find(command => command?.requestId === operation.requestId);
      if (match) { if (operation.command.state === 'unknown' && TERMINAL.has(match.state)) state.error = ''; operation.command = match; }
      if (!operation.transport && active(operation.command, now()) === false && !TERMINAL.has(operation.command.state)) {
        operation.command = { ...operation.command, state: 'expired', error: 'No confirmed outcome before the request expired. The request will not be retried.' };
      }
      if (operation.action === 'draft' && operation.command.state === 'completed' && !operation.draftApplied) {
        operation.draftApplied = true;
        const draft = operation.command.result?.text ?? operation.command.result?.summary;
        if (typeof draft === 'string') {
          const summary = operation.params?.mode === 'summary';
          form.draftResult = { title: summary ? 'Chat summary' : 'Draft reply', text: draft };
          if (!summary && draft.length <= 300 && form.textRevision === operation.textRevision) { form.text = draft; form.textRevision++; }
        }
      }
    }
  }
  async function refresh() {
    if (flight) return flight;
    flight = (async () => {
      try {
        const response = await fetchImpl(controllerPath(basePath, '/api/accounts'), { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw responseError(response);
        const data = await response.json();
        if (!data || !Array.isArray(data.instances) || !Number.isFinite(timestamp(data.updatedAt))) throw Error('invalid');
        state.data = data;
        state.network = fresh(data.updatedAt, HOST_FRESH_MS, now()) ? 'online' : 'stale';
        reconcile();
      } catch (error) { state.network = requestNetwork(error); }
      finally { flight = null; emit(); }
    })();
    return flight;
  }
  function canCommand(id, action) {
    if (!IDS.has(id) || !ACTIONS.has(action) || !hostFresh(state, now()) || typeof state.data?.csrfToken !== 'string' || !state.data.csrfToken || state.data.csrfToken.length > 256) return false;
    const instance = instanceFor(state, id);
    if (!instance) return false;
    const local = state.operations[id];
    const localPending = local && (local.transport || active(local.command, now()));
    const serverPending = active(instance.controls?.pending, now());
    if (action === 'stop') return !(localPending && local.action === 'stop') && !(serverPending && instance.controls.pending.action === 'stop');
    if (localPending || serverPending || !bridgeFresh(instance, now())) return false;
    if (instance.settings?.paused === true && !['start', 'watch', 'settings', 'drops-disable'].includes(action)) return false;
    if (action === 'start') return instance.authorized === true && instance.permissions?.playbackAccess === true;
    if (['draft', 'send'].includes(action)) return instance.authorized === true && instance.connected === true && !!instance.channel;
    return true;
  }
  async function command(id, action, params = {}) {
    if (!canCommand(id, action)) return false;
    const exactParams = commandParams(action, params);
    if (!exactParams) { state.error = action === 'send' ? 'Use 1–300 characters on one line, without links or chat commands. Remove spaces at the start and end.' : 'Check the channel and selected settings.'; emit(); return false; }
    const rid = requestId(), at = now();
    const operation = { requestId: rid, action, params: exactParams, transport: true, textRevision: formFor(id).textRevision,
      command: { requestId: rid, action, state: 'submitting', createdAt: at, expiresAt: at + 90000 } };
    state.operations[id] = operation; state.error = ''; emit();
    let accepted = false;
    try {
      const response = await fetchImpl(controllerPath(basePath, `/api/accounts/${id}/command`), { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.data.csrfToken }, body: JSON.stringify({ requestId: rid, action, params: exactParams }) });
      if (!response.ok) throw responseError(response);
      const result = await response.json();
      if (result?.ok !== true || result.command?.requestId !== rid || result.command?.action !== action || typeof result.command?.state !== 'string') throw Error('invalid');
      if (state.operations[id] === operation) { operation.command = result.command; accepted = true; }
    } catch (error) {
      if (state.operations[id] === operation) {
        operation.command.state = 'unknown';
        const network = requestNetwork(error);
        if (network !== 'offline') state.network = network;
        state.error = network === 'offline' ? 'The request outcome is unconfirmed. Checking account status; it will not be sent again automatically. Stop remains available.' : `${connectionMessage(network, basePath)} The request outcome is unconfirmed.`;
      }
    } finally {
      operation.transport = false;
      emit();
    }
    // A GET already in flight may predate the action. It cannot be its confirmation.
    if (flight) await flight;
    await refresh();
    return accepted;
  }
  function edit(id, key, value) {
    if (!IDS.has(id) || !['channel', 'chatMode', 'replySource', 'autoResume', 'text'].includes(key)) return;
    const form = formFor(id); form[key] = value; form.dirty[key] = true;
    if (key === 'text') form.textRevision++;
    emit();
  }
  return { getState: () => state, refresh, canCommand, command, edit, form: formFor,
    start() { if (timer === null) { void refresh(); timer = setIntervalImpl(() => { if (state.network === 'online' && !fresh(state.data?.updatedAt, HOST_FRESH_MS, now())) { state.network = 'stale'; emit(); } void refresh(); }, POLL_MS); } },
    stop() { if (timer !== null) clearIntervalImpl(timer); timer = null; } };
}

const NODE_IDS = ['page-eyebrow','page-title','page-description','network-status','connection-notice','access-actions','command-error','accounts-overview','account-cards','account-detail','account-reason','session-state','channel','chat-mode','reply-source','auto-resume','start','stop','watch','save-settings','settings-current','status-checks','operation-state','operation-detail','broadcast','draft','summary','draft-result','message-text','text-count','send','chat-count','chat-digest','incoming-chat','sent-count','delivery-history','drops-state','drops-detail','drops-enable','drops-disable','drops-check','command-history','last-refreshed'];
export function createAccountsView(document) {
  const nodes = Object.fromEntries(NODE_IDS.map(id => [id, document.getElementById(id)]));
  function el(tag, content, className) { const node = document.createElement(tag); if (content !== undefined) node.textContent = String(content); if (className) node.className = className; return node; }
  return { nodes, el };
}
function pill(view, content, tone = 'muted') { const node = view.el('span', content, 'pill'); node.setAttribute('data-tone', tone); return node; }
function setPill(node, content, tone = 'muted') { node.textContent = content; node.setAttribute('data-tone', tone); }
function empty(view, content, tag = 'p') { return view.el(tag, content, 'empty'); }
function bridgeReason(instance, now) {
  if (!instance || instance.available !== true) return text(instance?.error, 'Account helper is unavailable. Open the account profile and check its extension.');
  if (!bridgeFresh(instance, now)) return instance.browser?.online === true ? 'Browser check-in is stale. Reopen the account profile and its extension. Start and other browser controls are held; Stop can still hold the helper.' : 'Browser profile is closed or its extension is unavailable. Open this account’s profile to use browser controls. Stop can still hold the helper.';
  if (!instance.authorized) return text(instance.error, 'This account needs to sign in again in its extension.');
  if (instance.permissions?.playbackAccess !== true) return 'Playback access is missing. Open the extension’s fallback controls in this profile to grant access before Start.';
  return text(instance.error, text(instance.watch?.error, ''));
}
function playback(instance, now, stale = false) {
  const watch = instance?.watch;
  if (stale || !bridgeFresh(instance, now)) return { title: 'Unverified', detail: `Last reported: ${text(watch?.status, 'unknown')}`, tone: 'warn' };
  if (!watch || !fresh(watch.checkedAt, BRIDGE_FRESH_MS, now)) return { title: 'Unverified', detail: watch?.error || 'No recent video check.', tone: 'warn' };
  const status = text(watch.status, 'unknown');
  return { title: label({ playing: 'Playing', paused: 'Paused', offline: 'Channel offline', buffering: 'Buffering', error: 'Playback error', not_found: 'Watch page missing', stopped: 'Stopped', idle: 'Idle', unknown: 'Unverified' }, status, status), detail: text(watch.error, `${watch.channel ? `#${watch.channel} · ` : ''}${age(watch.checkedAt, now)}`), tone: status === 'playing' ? 'good' : 'warn' };
}
function pair(view, name, value) { const node = view.el('div'); node.append(view.el('dt', name), view.el('dd', value)); return node; }
function sessionStatus(instance, state, now) {
  if (!hostFresh(state, now)) return { title: 'Status stale', tone: 'warn' };
  if (!bridgeFresh(instance, now)) return { title: 'Session unverified', tone: 'warn' };
  if (instance?.settings?.paused === true) return { title: 'Stopped', tone: 'muted' };
  if (instance?.settings?.paused === false) return { title: 'Session enabled', tone: 'good' };
  return { title: 'Unavailable', tone: 'muted' };
}
function renderCards(view, state, now) {
  const cards = [];
  for (const id of ['primary', 'test']) {
    const instance = instanceFor(state, id), stale = !hostFresh(state, now), playing = playback(instance, now, stale);
    const card = view.el('article', undefined, 'account-card'), heading = view.el('div', undefined, 'card-heading'), title = view.el('div');
    title.append(view.el('h2', text(instance?.name, id === 'primary' ? 'Main companion' : 'Second companion')), view.el('p', text(instance?.account, 'Account not available'), 'account-login'));
    const session = sessionStatus(instance, state, now);
    heading.append(title, pill(view, session.title, session.tone));
    const details = view.el('dl', undefined, 'card-details');
    details.append(pair(view, 'Channel', instance?.channel ? `#${instance.channel}` : 'No channel'), pair(view, 'Playback', playing.title), pair(view, 'Chat', stale ? 'Unverified' : instance?.connected ? 'Connected' : 'Disconnected'), pair(view, 'Browser bridge', stale ? 'Unverified' : bridgeFresh(instance, now) ? 'Current' : 'Unavailable'));
    const reason = view.el('p', stale ? 'Showing last known account data. Waiting for a fresh host response.' : bridgeReason(instance, now) || text(instance?.activity?.reason, 'Ready for account controls.'), 'card-reason');
    const link = view.el('a', 'Open account controls', 'open-account'); link.setAttribute('href', controllerPath(state.basePath || '', `/accounts/${id}`));
    card.append(heading, details, reason, link); cards.push(card);
  }
  view.nodes['account-cards'].replaceChildren(...cards);
}
function check(view, name, title, detail, tone = 'muted') {
  const node = view.el('div', undefined, 'status-check'); node.setAttribute('data-tone', tone);
  node.append(view.el('span', name, 'check-label-text'), view.el('strong', title), view.el('p', detail)); return node;
}
function commandName(command) { return command?.action === 'draft' && command.params?.mode === 'summary' ? 'Summarize chat' : label(ACTION_LABELS, command?.action, 'Control request'); }
function commandState(command) { return label(STATE_LABELS, command?.state, 'Unverified'); }
function commandReason(command) {
  if (command?.error) return command.error;
  if (command?.result?.reason) return command.result.reason;
  return label({ submitting: 'Sending the request to the local helper.', queued: 'Accepted by the helper; waiting for the extension. This is not confirmation of execution.', running: 'The extension is working on this request.', completed: command?.action === 'send' ? 'Command finished. Check the delivery record below for the actual chat outcome.' : 'The extension reported that this request finished.', cancelled: 'This request was cancelled.', failed: 'The request failed.', expired: 'The request expired without a confirmed result. It will not be retried.', unknown: 'Waiting for an outcome. This request will not be retried automatically.' }, command?.state, 'Waiting for account confirmation.');
}
function commandTone(command) { return command?.state === 'completed' ? 'good' : ['failed', 'expired'].includes(command?.state) ? 'error' : !TERMINAL.has(command?.state) ? 'warn' : 'muted'; }
function renderOperation(view, state, instance, id, now) {
  const local = state.operations[id]?.command;
  const pending = instance?.controls?.pending;
  const latest = [local, ...list(instance?.controls?.recent)].filter(Boolean).sort((a, b) => (timestamp(b.createdAt) || 0) - (timestamp(a.createdAt) || 0))[0];
  const command = active(local, now) ? local : active(pending, now) ? pending : latest;
  if (!command) { setPill(view.nodes['operation-state'], 'No pending operation'); view.nodes['operation-detail'].replaceChildren(empty(view, 'No control requests to show.')); }
  else {
    setPill(view.nodes['operation-state'], commandState(command), commandTone(command));
    view.nodes['operation-detail'].replaceChildren(view.el('p', commandName(command), 'command-line'), view.el('p', commandReason(command), 'message-detail'), view.el('p', `Requested ${age(command.createdAt, now)}${active(command, now) ? ' · Stop can interrupt an older Start.' : ''}`, 'message-detail'));
  }
  const recent = list(instance?.controls?.recent).slice(0, 15).map(item => {
    const row = view.el('li'), meta = view.el('div', undefined, 'message-meta'); meta.append(view.el('strong', commandName(item)), view.el('span', age(item.createdAt, now)));
    row.append(meta, pill(view, commandState(item), commandTone(item)), view.el('p', commandReason(item), 'message-detail')); return row;
  });
  view.nodes['command-history'].replaceChildren(...(recent.length ? recent : [empty(view, 'No recent control requests.', 'li')]));
}
function renderBroadcast(view, instance, now, current) {
  const stream = instance?.streamContext, activity = instance?.activity, fragment = view.el('div');
  const verified = current && fresh(stream?.checkedAt, BRIDGE_FRESH_MS, now);
  fragment.append(pill(view, !verified ? 'Broadcast unverified · last known context' : stream?.isLive === true ? 'Live broadcast reported' : stream?.isLive === false ? 'Channel offline' : 'Broadcast unverified', verified && stream?.isLive === true ? 'good' : 'muted'));
  fragment.append(view.el('p', text(stream?.title, 'No broadcast title available.'), 'broadcast-title'));
  const details = view.el('dl', undefined, 'detail-pair'); details.append(pair(view, 'Category', text(stream?.gameName, 'Unknown')), pair(view, 'Context checked', age(stream?.checkedAt, now)), pair(view, 'Participation', text(activity?.state, 'No activity reported')), pair(view, 'Shared coordination', instance?.coordination?.available === false ? 'Unavailable' : instance?.coordination?.paused === true ? 'Paused' : instance?.coordination ? 'Available' : 'Unverified'));
  fragment.append(details, view.el('p', text(activity?.reason, 'No recent participation decision.'), 'broadcast-reason'));
  if (instance?.coordination?.reason) fragment.append(view.el('p', instance.coordination.reason, 'broadcast-reason'));
  view.nodes.broadcast.replaceChildren(fragment);
}
function renderMessages(view, instance, now) {
  const chat = list(instance?.chat?.messages).slice(-60).reverse();
  view.nodes['chat-count'].textContent = `${chat.length} shown`;
  const digest = instance?.chat?.digest;
  view.nodes['chat-digest'].textContent = digest ? `${number(digest.messages)} messages · ${number(digest.people)} people${list(digest.topics).length ? ` · ${digest.topics.filter(x => typeof x === 'string').slice(0, 5).join(', ')}` : ''}` : 'No chat digest available.';
  view.nodes['incoming-chat'].replaceChildren(...(chat.length ? chat.map(message => {
    const node = view.el('li'), meta = view.el('div', undefined, 'message-meta'); meta.append(view.el('strong', text(message.author, 'Unknown author')), view.el('span', age(message.at, now)));
    node.append(meta, view.el('p', text(message.text, ''), 'message-body')); return node;
  }) : [empty(view, 'No incoming chat recorded yet.', 'li')]));
  const sent = list(instance?.sent).filter(message => message && typeof message === 'object')
    .sort((a, b) => (timestamp(b.at) || 0) - (timestamp(a.at) || 0)).slice(0, 50);
  view.nodes['sent-count'].textContent = `${sent.length} shown`;
  view.nodes['delivery-history'].replaceChildren(...(sent.length ? sent.map(message => {
    const node = view.el('li'), meta = view.el('div', undefined, 'message-meta'), delivery = text(message.delivery, 'unconfirmed');
    meta.append(view.el('strong', message.channel ? `#${message.channel}` : 'Channel unknown'), view.el('span', age(message.at, now)));
    const status = view.el('span', label({ confirmed: 'Delivery confirmed', rejected: 'Delivery rejected', unknown: 'Delivery unconfirmed', submitted: 'Submitted · unconfirmed', suppressed: 'Suppressed', failed: 'Failed', pending: 'Pending' }, delivery, `Delivery: ${delivery}`), 'delivery'); status.setAttribute('data-tone', delivery === 'confirmed' ? 'good' : ['rejected', 'failed'].includes(delivery) ? 'error' : 'warn');
    node.append(meta, status, view.el('p', text(message.text, ''), 'message-body'));
    if (message.reason) node.append(view.el('p', message.reason, 'message-detail'));
    if (message.replyTo) node.append(view.el('p', `Reply to ${message.replyTo}`, 'message-detail'));
    return node;
  }) : [empty(view, 'No delivery records yet. Queued commands are not chat delivery records.', 'li')]));
}
function renderDrops(view, instance, now) {
  const drops = instance?.drops;
  setPill(view.nodes['drops-state'], drops ? drops.enabled ? 'Enabled' : 'Disabled' : 'Unverified', drops?.enabled ? 'good' : 'muted');
  const content = view.el('div'); content.append(view.el('p', text(drops?.reason, text(drops?.error, text(drops?.status, text(drops?.state, 'No drops status reported.')))), 'section-description'));
  content.append(view.el('p', `Last check: ${age(drops?.lastCheckAt ?? drops?.lastCheck ?? drops?.checkedAt, now)}`, 'message-detail'));
  if (drops && ['claimed', 'available', 'pending'].some(key => Number.isFinite(drops[key]))) content.append(view.el('p', `${number(drops.claimed)} claimed · ${number(drops.available)} available · ${number(drops.pending)} pending`, 'drops-counts'));
  const history = list(drops?.history).slice(-5).reverse();
  for (const item of history) content.append(view.el('p', `${text(item.name, 'Drop')} · ${text(item.delivery, 'Unconfirmed')} · ${age(item.at, now)}${item.reason ? ` · ${item.reason}` : ''}`, 'message-detail'));
  view.nodes['drops-detail'].replaceChildren(content);
}
export function renderAccounts(view, state, { id = null, now = Date.now(), canCommand = () => false } = {}) {
  const n = view.nodes, online = hostFresh(state, now);
  setPill(n['network-status'], networkTitle(online ? 'online' : state.network, state.basePath), online ? 'good' : 'warn');
  n['connection-notice'].hidden = online || state.network === 'loading';
  n['connection-notice'].textContent = connectionMessage(state.network, state.basePath, !!state.data);
  n['access-actions'].hidden = !state.basePath || !['unauthenticated', 'forbidden'].includes(state.network);
  n['command-error'].textContent = state.error || ''; n['command-error'].hidden = !state.error;
  n['last-refreshed'].textContent = state.data ? `Host refreshed ${age(state.data.updatedAt, now)}` : 'Waiting for status';
  n['accounts-overview'].hidden = !!id; n['account-detail'].hidden = !id;
  if (!id) { renderCards(view, state, now); return; }
  const instance = instanceFor(state, id), form = state.forms[id] || { channel: '', chatMode: 'mentions', replySource: 'local', autoResume: false, text: '' };
  n['page-eyebrow'].textContent = id === 'primary' ? 'Primary profile' : 'Second profile';
  n['page-title'].textContent = text(instance?.name, id === 'primary' ? 'Main companion' : 'Second companion');
  n['page-description'].textContent = instance?.account ? `@${instance.account} · controls stay with this account’s browser profile.` : 'Waiting for this account to report its status.';
  const reason = online ? bridgeReason(instance, now) : connectionMessage(state.network, state.basePath, !!state.data) || 'Account data is not current. Waiting for the host.';
  n['account-reason'].textContent = reason; n['account-reason'].hidden = !reason;
  const session = sessionStatus(instance, state, now);
  setPill(n['session-state'], session.title, session.tone);
  for (const [node, key] of [['channel', 'channel'], ['chat-mode', 'chatMode'], ['reply-source', 'replySource'], ['message-text', 'text']]) if (n[node].value !== form[key]) n[node].value = form[key];
  n['auto-resume'].checked = form.autoResume === true;
  n['text-count'].textContent = `${(form.text || '').length} / 300`;
  n['draft-result'].hidden = !form.draftResult;
  n['draft-result'].replaceChildren(...(form.draftResult ? [view.el('strong', form.draftResult.title), view.el('p', form.draftResult.text, 'message-body')] : []));
  n.start.disabled = !canCommand(id, 'start') || !validChannel(form.channel);
  n.stop.disabled = !canCommand(id, 'stop'); n.watch.disabled = !canCommand(id, 'watch'); n['save-settings'].disabled = !canCommand(id, 'settings');
  n.draft.disabled = !canCommand(id, 'draft'); n.summary.disabled = !canCommand(id, 'draft'); n.send.disabled = !canCommand(id, 'send') || !validMessage(form.text);
  for (const action of ['drops-enable', 'drops-disable', 'drops-check']) n[action].disabled = !canCommand(id, action) || (action === 'drops-enable' && instance?.drops?.enabled === true) || (action === 'drops-disable' && instance?.drops?.enabled === false);
  const operation = state.operations[id];
  n.start.textContent = operation?.action === 'start' && (operation.transport || active(operation.command, now)) ? `${commandState(operation.command)}…` : 'Start companion';
  n.stop.textContent = operation?.action === 'stop' && (operation.transport || active(operation.command, now)) ? `${commandState(operation.command)}…` : 'Stop';
  const settings = instance?.settings;
  const currentBridge = online && bridgeFresh(instance, now);
  n['settings-current'].textContent = !instance?.browser?.lastSeenAt ? 'Settings unverified. Waiting for the browser’s first check-in.' : settings ? `${currentBridge ? 'Current' : 'Last reported settings'}: ${settings.chatMode === 'participate' ? 'Occasional participation' : 'Mentions'} · ${settings.replySource === 'ai' ? 'AI replies' : 'Local replies'} · recovery ${settings.autoResume ? 'on' : 'off'} · ${settings.autoReply ? 'automatic replies on' : 'automatic replies off'}` : 'Current settings unavailable.';
  const video = playback(instance, now, !online);
  n['status-checks'].replaceChildren(check(view, 'Chat connection', !online ? 'Unverified' : instance?.connected ? 'Connected' : 'Disconnected', instance?.channel ? `#${instance.channel}` : 'No current chat channel', online && instance?.connected ? 'good' : 'warn'), check(view, 'Video playback', video.title, video.detail, video.tone), check(view, 'Browser bridge', !online ? 'Unverified' : currentBridge ? 'Current' : 'Unavailable', `Last check-in: ${age(instance?.browser?.lastSeenAt, now)}`, currentBridge ? 'good' : 'warn'), check(view, 'Playback access', !online ? 'Unverified' : instance?.permissions?.playbackAccess === true ? 'Granted' : 'Required', !online ? 'Waiting for a fresh host response.' : instance?.permissions?.playbackAccess === true ? 'Permission is separate from playback.' : 'Grant in the extension fallback controls.', online && instance?.permissions?.playbackAccess === true ? 'good' : 'warn'));
  renderOperation(view, state, instance, id, now); renderBroadcast(view, instance, now, online && currentBridge); renderMessages(view, instance, now); renderDrops(view, instance, now);
}

if (globalThis.document?.querySelector('[data-accounts-app]')) {
  const basePath = basePathFromModule(import.meta.url);
  const document = globalThis.document, id = accountFromPath(globalThis.location.pathname, basePath), view = createAccountsView(document);
  configureControllerMount(document, basePath);
  const controller = createAccountsController({ basePath, onState: state => renderAccounts(view, state, { id, canCommand: controller.canCommand }) });
  if (id) {
    const n = view.nodes;
    for (const [node, key] of [['channel','channel'],['chat-mode','chatMode'],['reply-source','replySource'],['message-text','text']]) n[node].addEventListener('input', () => controller.edit(id, key, n[node].value));
    n['auto-resume'].addEventListener('change', () => controller.edit(id, 'autoResume', n['auto-resume'].checked));
    const settings = () => { const form = controller.form(id); return { chatMode: form.chatMode, replySource: form.replySource, autoResume: form.autoResume }; };
    document.getElementById('session-form').addEventListener('submit', event => { event.preventDefault(); void controller.command(id, 'start', { channel: controller.form(id).channel, ...settings() }); });
    n['save-settings'].addEventListener('click', () => void controller.command(id, 'settings', settings()));
    n.draft.addEventListener('click', () => void controller.command(id, 'draft', { mode: 'reply' }));
    n.summary.addEventListener('click', () => void controller.command(id, 'draft', { mode: 'summary' }));
    n.send.addEventListener('click', () => void controller.command(id, 'send', { text: controller.form(id).text }));
    for (const action of ['stop','watch','drops-enable','drops-disable','drops-check']) n[action].addEventListener('click', () => void controller.command(id, action));
  }
  bindControllerLifecycle(controller);
  controller.start();
}
