import { controllerBasePath, basePathFromModule, controllerPath, responseError, requestNetwork, networkTitle, connectionMessage, configureControllerMount, bindControllerLifecycle } from './controller-path.js';

const POLL_MS = 2500;
const STALE_MS = 10000;
const LIMIT = 600;
const text = (value, fallback = '') => typeof value === 'string' ? value.slice(0, LIMIT) : fallback;
const number = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function relativeAge(value, now = Date.now()) {
  const at = time(value);
  if (!Number.isFinite(at)) return 'No check-in';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function remaining(value, now = Date.now()) {
  const at = time(value);
  if (!Number.isFinite(at) || at <= now) return '';
  const seconds = Math.ceil((at - now) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function uptime(value) {
  const seconds = Math.floor(number(value));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function validStatus(value) {
  return value && typeof value === 'object' && typeof value.paused === 'boolean'
    && Number.isFinite(time(value.updatedAt)) && value.host && typeof value.host === 'object'
    && Array.isArray(value.clients) && Array.isArray(value.channels) && Array.isArray(value.events);
}

export function createController({ fetchImpl = globalThis.fetch, now = Date.now, onState = () => {},
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval, basePath = '' } = {}) {
  basePath = controllerBasePath(basePath);
  const state = { basePath, data: null, network: 'loading', controlPending: false, controlKind: null, controlTarget: null, controlError: '' };
  let statusFlight = null, timer = null, stopped = false;
  const emit = () => { if (!stopped) onState({ ...state }); };
  const read = async (path, options = {}) => {
    const response = await fetchImpl(controllerPath(basePath, path), { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(4000), ...options });
    if (!response.ok) throw responseError(response);
    return response.json();
  };
  const fresh = () => state.data && now() - time(state.data.updatedAt) <= STALE_MS
    && time(state.data.updatedAt) <= now() + 5000 && state.network === 'online';
  const canControl = () => !state.controlPending && fresh() && typeof state.data.csrfToken === 'string'
    && state.data.csrfToken.length > 0 && state.data.csrfToken.length <= 256;
  const refresh = () => {
    if (statusFlight) return statusFlight;
    statusFlight = (async () => {
      try {
        const data = await read('/api/status', { headers: { Accept: 'application/json' } });
        if (!validStatus(data)) throw Error('Host status is not ready.');
        state.data = data;
        state.network = now() - time(data.updatedAt) > STALE_MS || time(data.updatedAt) > now() + 5000 ? 'stale' : 'online';
      } catch (error) { state.network = requestNetwork(error); }
      finally { statusFlight = null; emit(); }
      return state.data;
    })();
    return statusFlight;
  };
  const mutate = async (key, desired) => {
    if (!canControl()) return false;
    state.controlPending = true; state.controlKind = key; state.controlTarget = desired; state.controlError = ''; emit();
    try {
      const result = await read('/api/control', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': state.data.csrfToken
      }, body: JSON.stringify({ [key]: desired }) });
      if (result?.ok === false) throw Error('Control not accepted.');
      // A read that started before the control response cannot confirm it.
      if (statusFlight) await statusFlight;
      await refresh();
      if (!fresh()) {
        state.controlError = 'The control request was sent. Waiting for fresh host status to confirm the result.';
        return false;
      }
      const actual = key === 'paused' ? state.data.paused : state.data.exchanges?.enabled;
      if (actual !== desired) {
        state.controlError = 'The requested setting was not confirmed. Review the refreshed host state before trying again.';
        return false;
      }
      return true;
    } catch (error) {
      const network = requestNetwork(error);
      if (network !== 'offline') state.network = network;
      state.controlError = network === 'offline' ? 'Could not confirm the host setting. Refresh status before trying again.' : `${connectionMessage(network, basePath)} The requested setting was not confirmed.`;
      await refresh();
      return false;
    } finally { state.controlPending = false; state.controlKind = null; state.controlTarget = null; emit(); }
  };
  const toggle = () => canControl() ? mutate('paused', !state.data.paused) : Promise.resolve(false);
  const toggleExchanges = () => canControl() && typeof state.data.exchanges?.enabled === 'boolean'
    ? mutate('exchangesEnabled', !state.data.exchanges.enabled) : Promise.resolve(false);
  return {
    refresh, toggle, toggleExchanges, canControl,
    getState: () => ({ ...state }),
    start() { if (timer !== null) return; stopped = false; void refresh(); timer = setIntervalImpl(() => { void refresh(); }, POLL_MS); },
    stop() { stopped = true; if (timer !== null) clearIntervalImpl(timer); timer = null; }
  };
}

const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
function element(document, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
const tone = (node, value) => { node.setAttribute('data-tone', value); return node; };
const accountName = value => typeof value === 'string' && value ? `@${text(value)}` : 'Account not identified';
const lookup = (map, key, fallback) => typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : fallback;
const kindName = value => lookup({ greeting: 'Greeting', topic: 'Category question', conversation: 'Conversation reply', reply: 'Direct reply', manual: 'Manual message', exchange: 'Bot exchange' }, value, 'Contribution');
const playbackName = value => lookup({ playing: 'Playing', paused: 'Paused', ad: 'Ad playing', advertisement: 'Ad playing', buffering: 'Buffering', stalled: 'Stalled', offline: 'Offline', ended: 'Ended', checking: 'Checking', commercial: 'Commercial break', off: 'Checks off', error: 'Needs attention' }, value, 'Unverified');
const freshCheckIn = (client, now) => client.online === true && Number.isFinite(time(client.lastSeenAt))
  && time(client.lastSeenAt) <= now + 5000 && now - time(client.lastSeenAt) <= 45000;
const records = value => Array.isArray(value) ? value.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];

export function createView(document) {
  const ids = ['host-app', 'host-dot', 'host-status', 'coordination-state', 'coordination-toggle', 'connection-notice',
    'control-notice', 'access-actions', 'account-summary', 'channel-summary', 'uptime-summary', 'refresh-summary', 'accounts', 'channels', 'events', 'host-version',
    'exchange-state', 'exchange-toggle', 'exchange-policy', 'exchange-channels'];
  const nodes = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  if (ids.some(id => !nodes[id])) throw Error('Host interface is incomplete.');
  return { document, nodes };
}

function renderAccount(document, client, now, stale, paused) {
  const card = element(document, 'article', 'account-card');
  const online = freshCheckIn(client, now);
  const ready = online && client.ready === true && !stale && !paused;
  const status = !online ? 'Check-in stale' : paused && client.connected === true ? 'On hold' : ready ? 'Ready for a turn' : client.connected === true ? 'Waiting' : 'Disconnected';
  const top = element(document, 'div', 'account-top');
  const identity = element(document, 'div', 'account-identity');
  const monogram = element(document, 'span', 'account-monogram', text(client.account, '—').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '—');
  monogram.setAttribute('aria-hidden', 'true');
  const names = element(document, 'div');
  names.append(element(document, 'h3', 'account-name', accountName(client.account)), element(document, 'p', 'account-label', text(client.name, 'Companion')));
  identity.append(monogram, names);
  top.append(identity, tone(element(document, 'span', 'badge', stale ? 'Status stale' : status), ready ? 'good' : !online || stale || paused ? 'warning' : 'muted'));
  const channel = element(document, 'p', 'account-channel');
  channel.append(element(document, 'span', 'channel-hash', '#'), element(document, 'span', client.channel ? '' : 'muted', client.channel ? text(client.channel) : 'No channel selected'));
  const details = element(document, 'dl', 'connection-grid');
  const playback = typeof client.playback === 'object' ? client.playback?.status : client.playback;
  const rows = [
    ['Chat connection', client.connected === true ? (!online || stale ? 'Last: connected' : 'Connected') : 'Disconnected', online && !stale && client.connected === true ? 'good' : 'muted'],
    ['Playback', playbackName(playback), !stale && online && ['playing', 'ad', 'advertisement'].includes(playback) ? 'good' : ['paused', 'stalled', 'error'].includes(playback) ? 'warning' : 'muted'],
    ['Last check-in', relativeAge(client.lastSeenAt, now), 'muted']
  ];
  for (const [label, value, color] of rows) {
    const item = element(document, 'div'); item.append(element(document, 'dt', '', label), tone(element(document, 'dd', '', value), color)); details.append(item);
  }
  card.append(top, channel, details, element(document, 'p', 'account-decision', text(client.lastDecision, 'No turn request yet.')));
  const pending = Math.floor(number(client.pendingCompletions));
  if (pending) card.append(element(document, 'p', 'completion-note', `${pending} delivery update${pending === 1 ? '' : 's'} awaiting sync`));
  return card;
}

function renderChannel(document, channel, policy, now, paused) {
  const card = element(document, 'article', 'channel-card');
  card.append(element(document, 'h3', 'channel-title', accountName(channel.channel)));
  const max = Math.max(1, Math.floor(number(policy?.maxAttemptsPerHour, 6))), count = Math.floor(number(channel.attemptsLastHour));
  const balance = element(document, 'div', 'channel-balance');
  balance.append(element(document, 'span', '', 'Submission attempts this hour'));
  const total = element(document, 'strong', '', String(count)); total.append(element(document, 'span', '', ` / ${max}`)); balance.append(total);
  const meter = element(document, 'meter', 'channel-meter'); meter.min = 0; meter.max = max; meter.value = Math.min(count, max);
  meter.setAttribute('aria-label', `${count} of ${max} shared submission attempts used this hour`);
  const wait = remaining(channel.nextTurnAt, now);
  const status = paused ? 'Coordination is paused' : channel.activeSpeaker ? `Turn reserved for ${accountName(channel.activeSpeaker)}`
    : count >= max ? 'Shared hourly limit reached' : wait ? `Next turn in ${wait}` : 'No channel cooldown';
  card.append(balance, meter, tone(element(document, 'p', 'turn-status', status), paused || wait || count >= max ? 'warning' : 'good'));
  const waiting = records(channel.waiting).slice(0, 16);
  if (waiting.length) {
    card.append(element(document, 'p', 'waiting-label', 'Waiting for a turn'));
    const list = element(document, 'ul', 'waiting-list');
    for (const item of waiting) {
      const entry = element(document, 'li', 'waiting-item');
      entry.append(element(document, 'strong', '', accountName(item.account)), element(document, 'span', '', ` · ${kindName(item.kind)}`), element(document, 'p', '', text(item.reason, 'Waiting for coordination.')));
      list.append(entry);
    }
    card.append(list);
  } else card.append(element(document, 'p', 'quiet-note', 'Nobody is waiting for a turn.'));
  return card;
}

function renderEvent(document, event) {
  const item = element(document, 'li', 'event');
  const delivery = text(event.delivery), type = text(event.type);
  const labels = { reserved: 'Turn reserved', leased: 'Turn reserved', begin: 'Submission started', submitting: 'Submission started', confirmed: 'Twitch confirmed', rejected: 'Twitch rejected', unknown: 'Delivery uncertain', cancelled: 'Turn cancelled', held: 'Turn held', hold: 'Turn held', blocked: 'Turn held', paused: 'Coordination paused', resumed: 'Coordination resumed', sync: 'Account checked in', finish: 'Delivery updated', finished: 'Delivery updated' };
  const label = lookup(labels, delivery, '') || lookup(labels, type, '') || (type ? type.replace(/[_-]/g, ' ').slice(0, 70) : 'Coordination updated');
  const color = delivery === 'confirmed' ? 'good' : ['unknown', 'rejected'].includes(delivery) ? 'warning' : ['hold', 'held', 'blocked'].includes(type) ? 'warning' : 'muted';
  const dot = tone(element(document, 'span', 'event-indicator'), color); dot.setAttribute('aria-hidden', 'true');
  const content = element(document, 'div'); content.append(element(document, 'p', 'event-title', label));
  const route = [event.account ? accountName(event.account) : '', event.channel ? `#${text(event.channel)}` : '', event.kind ? kindName(event.kind) : ''].filter(Boolean).join(' · ');
  if (route) content.append(element(document, 'p', 'event-route', route));
  if (event.reason) content.append(element(document, 'p', 'event-reason', text(event.reason)));
  const at = time(event.at), timestamp = element(document, 'time');
  if (Number.isFinite(at)) { timestamp.dateTime = new Date(at).toISOString(); timestamp.textContent = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); timestamp.title = new Date(at).toLocaleString(); }
  else timestamp.textContent = '—';
  item.append(dot, content, timestamp); return item;
}

function minutesRange(minimum, maximum, fallbackMin, fallbackMax) {
  const first = Math.max(1, Math.round(number(minimum, fallbackMin) / 60000));
  const last = Math.max(first, Math.round(number(maximum, fallbackMax) / 60000));
  return first === last ? String(first) : `${first}–${last}`;
}

function renderExchangeChannel(document, channel, now) {
  const item = element(document, 'article', 'exchange-channel');
  const top = element(document, 'div', 'exchange-channel-top');
  top.append(element(document, 'h3', '', accountName(channel.channel)));
  const labels = { disabled: 'Disabled', waiting_for_partners: 'Waiting for two companions', scheduled: 'Scheduled', quiet_wait: 'Waiting for quiet chat',
    spacing_wait: 'Waiting for shared spacing', turn_1: 'First line scheduled', turn_2: 'Reply scheduled', paused: 'Coordination paused', exhausted: 'Scenes exhausted' };
  top.append(tone(element(document, 'span', 'badge', lookup(labels, channel.state, text(channel.state, 'Waiting'))), ['scheduled', 'turn_1', 'turn_2'].includes(channel.state) ? 'good' : 'muted'));
  item.append(top);
  if (channel.reason) item.append(element(document, 'p', 'exchange-reason', text(channel.reason)));
  const bottom = element(document, 'div', 'exchange-channel-meta'), wait = remaining(channel.nextAt, now);
  const next = wait ? `Next eligible in ${wait}` : channel.state === 'exhausted' ? 'No unused scenes remain'
    : channel.state === 'disabled' ? 'Enable to schedule' : channel.state === 'paused' ? 'Held until coordination resumes'
    : channel.state === 'waiting_for_partners' ? 'Waiting for two accounts to run' : 'Waiting on eligibility checks';
  bottom.append(element(document, 'span', '', next));
  bottom.append(element(document, 'span', '', `${Math.floor(number(channel.usedScenes))} / ${Math.floor(number(channel.totalScenes))} scenes used`));
  item.append(bottom); return item;
}

function renderExchanges(view, state, now, stale) {
  const { document, nodes: n } = view, data = state.data, exchanges = data?.exchanges;
  const available = typeof exchanges?.enabled === 'boolean';
  const label = !data ? 'Checking feature status' : stale ? 'Status stale' : !available ? 'Feature unavailable'
    : !exchanges.enabled ? 'Disabled' : data.paused ? 'Enabled · on hold' : 'Enabled';
  setText(n['exchange-state'], label);
  tone(n['exchange-state'], !available || stale ? 'muted' : exchanges.enabled && !data.paused ? 'good' : 'warning');
  const pending = state.controlPending && state.controlKind === 'exchangesEnabled';
  setText(n['exchange-toggle'], pending ? state.controlTarget ? 'Enabling…' : 'Disabling…'
    : exchanges?.enabled ? 'Disable bot exchanges' : 'Enable bot exchanges');
  n['exchange-toggle'].setAttribute('data-enabled', exchanges?.enabled === true ? 'true' : 'false');
  n['exchange-toggle'].disabled = !available || stale || state.controlPending || typeof data?.csrfToken !== 'string' || !data.csrfToken || data.csrfToken.length > 256;
  const interval = minutesRange(exchanges?.intervalMinMs, exchanges?.intervalMaxMs, 3600000, 7200000);
  const reply = minutesRange(exchanges?.replyMinMs, exchanges?.replyMaxMs, 180000, 360000);
  setText(n['exchange-policy'], `At most 2 lines · ${interval} minutes between exchanges · ${reply} minutes between lines`);
  const channels = records(exchanges?.channels).slice(0, 16);
  n['exchange-channels'].replaceChildren(...(channels.length ? channels.map(channel => renderExchangeChannel(document, channel, now))
    : [element(document, 'div', 'empty-state', !available ? 'Waiting for exchange status.' : !exchanges.enabled
      ? 'Bot exchanges are disabled. Enabling starts a warmup before the first eligible exchange.'
      : 'Waiting for two companions to run on the same live broadcast.')]));
}

export function renderHost(view, state, now = Date.now()) {
  const { document, nodes: n } = view, data = state.data;
  const stale = state.network !== 'online';
  n['host-app'].setAttribute('data-network', state.network);
  const health = data?.host?.health;
  const hostLabel = ['offline', 'unauthenticated', 'forbidden'].includes(state.network) ? networkTitle(state.network, state.basePath) : state.network === 'stale' ? 'Status is stale'
    : !data ? 'Connecting to host' : ['ready', 'healthy', 'ok'].includes(health) ? 'Host online' : 'Host needs attention';
  setText(n['host-status'], hostLabel); tone(n['host-dot'], stale || !data ? state.network === 'offline' ? 'bad' : 'warning' : ['ready', 'healthy', 'ok'].includes(health) ? 'good' : 'warning');
  setText(n['coordination-state'], !data ? 'Checking coordination' : stale ? 'Awaiting fresh status' : data.paused ? 'Coordination paused' : 'Coordination active');
  tone(n['coordination-state'], !data || stale ? 'muted' : data.paused ? 'warning' : 'good');
  const label = state.controlPending && state.controlKind !== 'exchangesEnabled' ? state.controlTarget ? 'Pausing…' : 'Resuming…' : data?.paused ? 'Resume coordination' : 'Pause coordination';
  setText(n['coordination-toggle'], label);
  n['coordination-toggle'].setAttribute('data-action', data?.paused ? 'resume' : 'pause');
  n['coordination-toggle'].disabled = !data || stale || state.controlPending || typeof data.csrfToken !== 'string' || !data.csrfToken || data.csrfToken.length > 256;
  const connectionNotice = connectionMessage(state.network, state.basePath, !!data);
  setText(n['connection-notice'], connectionNotice); n['connection-notice'].hidden = !connectionNotice;
  n['access-actions'].hidden = !state.basePath || !['unauthenticated', 'forbidden'].includes(state.network);
  setText(n['control-notice'], state.controlError || ''); n['control-notice'].hidden = !state.controlError;
  const clients = records(data?.clients).slice(0, 16), channels = records(data?.channels).slice(0, 16);
  setText(n['account-summary'], data ? `${clients.filter(c => freshCheckIn(c, now)).length} / ${clients.length}` : '—');
  setText(n['channel-summary'], data ? String(channels.length) : '—');
  setText(n['uptime-summary'], data ? uptime(data.host?.uptimeSeconds) : '—');
  setText(n['refresh-summary'], data ? relativeAge(data.updatedAt, now) : 'Waiting for status');
  n.accounts.setAttribute('aria-busy', state.network === 'loading' ? 'true' : 'false');
  n.accounts.replaceChildren(...(clients.length ? clients.map(client => renderAccount(document, client, now, stale, data.paused)) : [element(document, 'div', 'empty-state', data ? 'No accounts have checked in yet.' : 'Waiting for the accounts to check in.')]));
  n.channels.replaceChildren(...(channels.length ? channels.map(channel => renderChannel(document, channel, data.policy, now, data.paused)) : [element(document, 'div', 'empty-state', 'A channel appears when an account checks in there.')]));
  const events = records(data?.events).slice(0, 40);
  n.events.replaceChildren(...(events.length ? events.map(event => renderEvent(document, event)) : [element(document, 'li', 'empty-state', 'No coordination decisions yet.')]));
  renderExchanges(view, state, now, stale);
  setText(n['host-version'], data?.version ? `Companion Host · ${text(data.version)}` : 'Companion Host');
}

if (globalThis.document?.querySelector('[data-host-app]')) {
  const basePath = basePathFromModule(import.meta.url);
  const view = createView(globalThis.document);
  configureControllerMount(globalThis.document, basePath);
  const controller = createController({ basePath, onState: state => renderHost(view, state) });
  view.nodes['coordination-toggle'].addEventListener('click', () => { void controller.toggle(); });
  view.nodes['exchange-toggle'].addEventListener('click', () => { void controller.toggleExchanges(); });
  renderHost(view, controller.getState()); controller.start();
  bindControllerLifecycle(controller);
}
