import { controllerBasePath, basePathFromModule, controllerPath, responseError, requestNetwork, networkTitle, connectionMessage, configureControllerMount, bindControllerLifecycle } from './controller-path.js';

export const ACCOUNT_IDS = Object.freeze(['primary', 'test', 'third', 'fourth']);
export const MESSAGE_KINDS = Object.freeze(['greeting', 'topic', 'reply', 'exchange', 'event']);
export const EVENT_CATEGORIES = Object.freeze(['bits', 'sub', 'resub', 'gift', 'gift_batch']);
export const REPLY_CATEGORIES = Object.freeze(['greeting', 'checkin', 'goodday', 'roughday', 'quietday', 'thanks', 'farewell', 'goodnight', 'welcome', 'dayfollowup', 'reciprocal', 'quietfollowup', 'dayplans', 'capabilities', 'automation', 'game', 'streamtitle', 'livestatus']);
export const TOPIC_CATEGORIES = Object.freeze(['general', 'just chatting', 'music', 'art']);
const NAMES = { primary: 'Main account', test: 'Second account', third: 'Third account', fourth: 'Fourth account' };
const KINDS = { greeting: 'Greeting', topic: 'Category question', reply: 'Reply', conversation: 'Conversation reply', manual: 'Reviewed message', exchange: 'Paired exchange', event: 'Event reaction' };
const EVENT_NAMES = { bits: 'Bits cheer', sub: 'Subscription', resub: 'Resubscription', gift: 'Gift subscription', gift_batch: 'Gift subscriptions together' };
const POLL_MS = 2500, FRESH_MS = 10000;
const rows = value => Array.isArray(value) ? value : [];
const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const safe = value => typeof value === 'string' ? value : '';
const known = (map, key, fallback) => Object.hasOwn(map, key ?? '') ? map[key] : fallback;
const bankString = value => {
  const bank = bankPayload(value);
  return JSON.stringify({ ...bank, entries: bank.entries.map(entry => ({ ...entry, accountIds: [...entry.accountIds].sort() })) });
};
let savedDirectorState = null;
export function savedDirectorProfile(id, now = Date.now()) {
  return savedDirectorState && directorFresh(savedDirectorState, now)
    ? rows(savedDirectorState.data.bank?.profiles).find(profile => profile.id === id) || null : null;
}
export function bankPayload(bank) {
  return { entries: rows(bank?.entries).map(entry => ({ id: entry.id, kind: entry.kind, category: entry.category,
    lines: rows(entry.lines).map(line => line), accountIds: rows(entry.accountIds).map(id => id), enabled: entry.enabled })),
  profiles: rows(bank?.profiles).map(profile => ({ id: profile.id, chatMode: profile.chatMode, replySource: profile.replySource })) };
}
export function bankValidation(bank) {
  if (!bank || !Array.isArray(bank.entries) || !bank.entries.length || bank.entries.length > 160) return 'Use between 1 and 160 message groups.';
  if (new Set(bank.entries.map(entry => entry.id)).size !== bank.entries.length) return 'Each message group needs its own identity.';
  for (let i = 0; i < bank.entries.length; i++) {
    const entry = bank.entries[i], prefix = `Message group ${i + 1}: `;
    if (typeof entry.id !== 'string' || !/^[a-z0-9_:-]{1,80}$/.test(entry.id) || !MESSAGE_KINDS.includes(entry.kind)) return prefix + 'choose a supported message kind.';
    if (!Array.isArray(entry.lines) || entry.lines.length < 1 || entry.lines.length > 16 || entry.kind === 'exchange' && entry.lines.length !== 2) return prefix + (entry.kind === 'exchange' ? 'use exactly two lines.' : 'use 1–16 options, one per line.');
    if (!Array.isArray(entry.accountIds) || !entry.accountIds.length || new Set(entry.accountIds).size !== entry.accountIds.length || entry.accountIds.some(id => !ACCOUNT_IDS.includes(id))) return prefix + 'choose at least one account.';
    if (typeof entry.enabled !== 'boolean') return prefix + 'check whether this group is enabled.';
    for (const line of entry.lines) {
      if (typeof line !== 'string' || line.trim() !== line || !line.length || line.length > 260 || /^[/.]|[\r\n\u0000-\u001f\u007f]|https?:\/\/|www\./i.test(line)) return prefix + 'each option needs 1–260 characters, without links, chat commands or blank lines.';
      const allowed = entry.kind === 'topic' ? ['game'] : entry.kind === 'reply' && entry.category === 'game' ? ['game'] : entry.kind === 'reply' && entry.category === 'streamtitle' ? ['title'] : [];
      if (/\{[^{}]*\}|[{}]/.test(line.replace(/\{(game|title)\}/g, (match, key) => allowed.includes(key) ? '' : match))) return prefix + 'use only the supported category or title substitution.';
      if (entry.kind === 'exchange' && /@|\[companion bot\]/i.test(line)) return prefix + 'write only the scene text; the host adds the partner mention.';
    }
    if (entry.kind === 'reply' ? !REPLY_CATEGORIES.includes(entry.category) : entry.kind === 'topic' ? !TOPIC_CATEGORIES.includes(entry.category) : entry.kind === 'event' ? !EVENT_CATEGORIES.includes(entry.category) : entry.category !== entry.kind) return prefix + 'choose a supported category.';
  }
  if (rows(bank.profiles).length !== ACCOUNT_IDS.length || new Set(bank.profiles.map(profile => profile.id)).size !== ACCOUNT_IDS.length || bank.profiles.some(profile => !ACCOUNT_IDS.includes(profile.id) || !['mentions', 'participate'].includes(profile.chatMode) || !['local', 'ai'].includes(profile.replySource))) return 'Choose a conversation mode and reply source for each account.';
  if (new TextEncoder().encode(JSON.stringify(bankPayload(bank))).length > 60000) return 'The message bank is too large. Remove some options before saving.';
  return '';
}
function validSnapshot(value) {
  return value?.protocol === 1 && typeof value.ready === 'boolean' && Number.isSafeInteger(value.revision) && value.revision >= 0
    && value.bank && Array.isArray(value.bank.entries) && Array.isArray(value.bank.profiles) && Array.isArray(value.plans) && Array.isArray(value.history)
    && Number.isFinite(stamp(value.updatedAt)) && typeof value.csrfToken === 'string';
}
export function directorFresh(state, now = Date.now()) {
  const at = stamp(state.data?.updatedAt);
  return state.network === 'online' && Number.isFinite(at) && at <= now + 5000 && now - at <= FRESH_MS;
}

export function createDirectorController({ fetchImpl = globalThis.fetch, now = Date.now, onState = () => {}, requestId = () => globalThis.crypto.randomUUID(), setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval, basePath = '', publishProfiles = false, historyAccount = 'all' } = {}) {
  basePath = controllerBasePath(basePath);
  const state = { basePath, data: null, network: 'loading', bank: null, editRevision: 0, dirty: false, baseRevision: null, conflict: false,
    mutation: null, feedback: '', error: '', tab: 'bank', kindFilter: 'all', bankAccount: 'all', historyAccount, historyHead: null, older: [], nextBeforeId: null, historyLoading: false, historyError: '', historyHeadError: '' };
  let flight = null, timer = null, historyGeneration = 0, headFlight = null, paged = false;
  const emit = () => onState(state);
  async function read(path, options = {}) {
    const response = await fetchImpl(controllerPath(basePath, path), { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000), ...options });
    let value;
    try { value = await response.json(); } catch { throw responseError(response); }
    if (!response.ok) throw Object.assign(responseError(response), { publicError: safe(value?.error), code: safe(value?.code) });
    return value;
  }
  function reconcile(data) {
    if (!state.bank || !state.dirty && !state.mutation) {
      state.bank = bankPayload(data.bank); state.baseRevision = data.revision; state.conflict = false;
    } else if (data.revision !== state.baseRevision && (!state.mutation || data.lastMutation?.requestId !== state.mutation.requestId)) state.conflict = true;
    const operation = state.mutation;
    const requestConfirmed = operation?.kind === 'bank' && data.lastMutation?.requestId === operation.requestId && data.lastMutation.revision > operation.expectedRevision;
    const desiredStateConfirmed = operation?.kind === 'bank' && data.revision > operation.expectedRevision && bankString(data.bank) === operation.submittedBank;
    if (operation?.kind === 'bank' && Number.isSafeInteger(operation.ackRevision) && data.revision > operation.ackRevision && !desiredStateConfirmed) {
      state.mutation = null; state.error = '';
      if (state.editRevision === operation.editRevision) {
        state.dirty = false; state.bank = bankPayload(data.bank); state.baseRevision = data.revision; state.conflict = false;
        state.feedback = 'Your save finished. A newer version was saved elsewhere and is shown here.';
      } else {
        state.conflict = true;
        state.feedback = 'Your save finished. Another tab saved a newer version while you were editing. Your unsaved edits are kept.';
      }
    } else if (requestConfirmed || desiredStateConfirmed) {
      state.baseRevision = data.revision; state.conflict = false;
      if (state.editRevision === operation.editRevision) { state.bank = bankPayload(data.bank); state.dirty = false; }
      state.mutation = null; state.error = ''; state.feedback = requestConfirmed ? 'Message bank saved. No account was started and no message was sent.' : 'The current saved bank matches your reviewed changes. No request was retried.';
      if (state.dirty) state.feedback += ' Newer local edits remain unsaved.';
    }
    if (operation?.kind === 'cancel') {
      const plan = data.plans.find(plan => plan.planId === operation.planId);
      if (!plan || ['cancelled', 'expired', 'confirmed', 'rejected', 'unknown'].includes(plan.state)) {
        state.mutation = null; state.feedback = plan?.state === 'cancelled' ? 'Pending message cancelled before submission.' : 'The outgoing record changed. Review its current delivery state.';
      }
    }
  }
  function updateHistoryHead(page) {
    if (!Array.isArray(page.history) || !(page.nextBeforeId == null || Number.isSafeInteger(page.nextBeforeId))) throw Error('invalid history');
    if (paged && state.historyHead?.length) {
      const ids = new Set(page.history.map(row => row.id));
      if (state.historyHead.some(row => ids.has(row.id))) {
        // Keep the boundary between the live head and any older pages already read.
        const archived = new Map(state.older.map(row => [row.id, row]));
        for (const row of state.historyHead) if (!ids.has(row.id)) archived.set(row.id, row);
        state.older = [...archived.values()];
      } else {
        // A whole page arrived while offline. The new head's cursor can reach the gap.
        historyGeneration++; paged = false; state.older = []; state.historyLoading = false; state.historyError = '';
      }
    }
    state.historyHead = page.history;
    if (!paged) state.nextBeforeId = page.nextBeforeId ?? null;
    state.historyHeadError = '';
  }
  function refreshAccountHistory() {
    if (headFlight) return headFlight;
    const generation = historyGeneration, id = state.historyAccount;
    const pending = read(`/api/director/history/${id}/0`).then(page => {
      if (generation === historyGeneration) updateHistoryHead(page);
    }).catch(() => {
      if (generation === historyGeneration) state.historyHeadError = 'Account history could not be refreshed.';
    }).finally(() => { if (headFlight === pending) headFlight = null; emit(); });
    headFlight = pending; return pending;
  }
  const refresh = () => {
    if (flight) return flight;
    flight = (async () => {
      try {
        const data = await read('/api/director');
        if (!validSnapshot(data)) throw Error('invalid director status');
        state.data = data; state.network = 'online';
        if (publishProfiles) savedDirectorState = state;
        if (!directorFresh(state, now())) state.network = 'stale';
        reconcile(data);
        if (state.historyAccount === 'all') updateHistoryHead(data);
        else if (state.network === 'online') await refreshAccountHistory();
      } catch (error) { state.network = requestNetwork(error); }
      finally { flight = null; emit(); }
      return state.data;
    })();
    return flight;
  };
  function edited() { state.editRevision++; state.dirty = true; state.feedback = 'Unsaved changes. Saving does not send messages.'; state.error = ''; emit(); }
  function editEntry(id, field, value) {
    const entry = state.bank?.entries.find(entry => entry.id === id);
    if (!entry || !['kind', 'category', 'lines', 'accountIds', 'enabled'].includes(field)) return;
    if (field === 'kind') {
      if (!MESSAGE_KINDS.includes(value)) return;
      entry.kind = value; entry.category = value === 'reply' ? 'greeting' : value === 'topic' ? TOPIC_CATEGORIES[0] : value === 'event' ? EVENT_CATEGORIES[0] : value;
    } else if (field === 'lines') entry.lines = typeof value === 'string' ? value.split('\n') : rows(value).map(line => line);
    else if (field === 'accountIds') entry.accountIds = ACCOUNT_IDS.filter(id => rows(value).includes(id));
    else if (field === 'enabled') entry.enabled = value === true;
    else entry.category = safe(value);
    edited();
  }
  function editProfile(id, field, value) {
    const profile = state.bank?.profiles.find(profile => profile.id === id);
    if (!profile || !['chatMode', 'replySource'].includes(field)) return;
    if (field === 'chatMode' && !['mentions', 'participate'].includes(value) || field === 'replySource' && !['local', 'ai'].includes(value)) return;
    profile[field] = value; edited();
  }
  function addEntry() {
    if (!state.bank || state.bank.entries.length >= 160) return false;
    const id = `message:${requestId().toLowerCase().replace(/[^a-z0-9_:-]/g, '').slice(0, 65)}`;
    if (state.bank.entries.some(entry => entry.id === id)) return false;
    state.bank.entries.push({ id, kind: 'greeting', category: 'greeting', lines: [''], accountIds: [...ACCOUNT_IDS], enabled: true }); edited(); return true;
  }
  function removeEntry(id) {
    if (!state.bank || !state.bank.entries.some(entry => entry.id === id)) return;
    state.bank.entries = state.bank.entries.filter(entry => entry.id !== id); edited();
  }
  function reloadBank() {
    if (!state.data || !directorFresh(state, now()) || state.mutation?.transport || state.mutation && state.mutation.kind !== 'bank') return;
    const abandoned = !!state.mutation; state.mutation = null;
    state.bank = bankPayload(state.data.bank); state.baseRevision = state.data.revision; state.dirty = false; state.conflict = false; state.editRevision++;
    state.feedback = abandoned ? 'Loaded the current saved bank and discarded local edits. The earlier request outcome is unconfirmed; nothing was retried.' : 'Loaded the saved bank. Your local edits were discarded.'; state.error = ''; emit();
  }
  const canSave = () => directorFresh(state, now()) && !!state.bank && state.dirty && !state.conflict && !state.mutation && !bankValidation(state.bank);
  async function mutate(path, body, operation) {
    state.mutation = { ...operation, requestId: body.requestId, transport: true }; state.error = ''; emit();
    try {
      const ack = await read(path, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.data.csrfToken }, body: JSON.stringify(body) });
      if (state.mutation?.requestId === body.requestId) {
        state.mutation.transport = false;
        if (operation.kind === 'bank' && ack?.ok === true && ack.requestId === body.requestId && ack.revision === body.expectedRevision + 1) state.mutation.ackRevision = ack.revision;
      }
      if (flight) await flight;
      await refresh();
      if (state.mutation?.requestId === body.requestId) { state.mutation.unknown = true; state.feedback = 'Request accepted. Waiting for fresh status to confirm its result.'; emit(); }
      return true;
    } catch (error) {
      if (state.mutation?.requestId === body.requestId) {
        if (error.status >= 400 && error.status < 500 && error.status !== 408) {
          state.mutation = null;
          const refreshRequired = ['controller_refresh_required', 'csrf_required'].includes(error.code);
          if (operation.kind === 'bank' && error.status === 409 && !refreshRequired) state.conflict = true;
          state.error = refreshRequired ? 'The controller connection needed to refresh. Your edits are kept. Review the current status before trying again.' : operation.kind === 'cancel' ? 'The message could not be cancelled. Review its current state; no cancellation was retried.' : error.status === 409 ? 'The bank changed elsewhere. Your edits are kept; load the saved bank before editing again.' : 'The change was not accepted. Check your entries and refresh status.';
        } else {
          state.mutation.transport = false; state.mutation.unknown = true;
          state.error = 'The request outcome is unconfirmed. Checking status; it will not be sent again automatically.';
        }
      }
      if (flight) await flight;
      await refresh(); emit(); return false;
    }
  }
  async function saveBank() {
    if (!canSave()) return false;
    const bank = bankPayload(state.bank), rid = requestId(), expectedRevision = state.baseRevision;
    return mutate('/api/director/bank', { requestId: rid, expectedRevision, bank }, { kind: 'bank', expectedRevision, editRevision: state.editRevision, submittedBank: bankString(bank) });
  }
  async function cancel(planId) {
    const plan = state.data?.plans.find(plan => plan.planId === planId);
    if (!directorFresh(state, now()) || state.mutation || !plan || plan.cancellable !== true) return false;
    return mutate('/api/director/cancel', { requestId: requestId(), planId }, { kind: 'cancel', planId });
  }
  function choose(field, value) {
    if (field === 'tab' && ['bank', 'outgoing'].includes(value)) state.tab = value;
    else if (field === 'kindFilter' && ['all', ...MESSAGE_KINDS].includes(value)) state.kindFilter = value;
    else if (['bankAccount', 'historyAccount'].includes(field) && ['all', ...ACCOUNT_IDS].includes(value)) {
      state[field] = value;
      if (field === 'historyAccount') {
        historyGeneration++; headFlight = null; paged = false; state.historyHead = null; state.older = [];
        state.nextBeforeId = null; state.historyError = ''; state.historyHeadError = ''; state.historyLoading = false;
        if (value === 'all' && state.data) updateHistoryHead(state.data);
        else if (value !== 'all' && directorFresh(state, now())) void refreshAccountHistory();
      }
    }
    emit();
  }
  async function loadHistory() {
    if (!directorFresh(state, now()) || state.historyLoading || state.nextBeforeId === null) return false;
    const generation = historyGeneration, accountId = state.historyAccount, beforeId = state.nextBeforeId;
    paged = true; state.historyLoading = true; state.historyError = ''; emit();
    try {
      const data = await read(`/api/director/history/${accountId}/${beforeId}`);
      if (generation !== historyGeneration) return false;
      if (!Array.isArray(data.history) || !(data.nextBeforeId === null || Number.isSafeInteger(data.nextBeforeId))) throw Error('invalid history');
      const byId = new Map([...state.older, ...data.history].map(row => [row.id, row])); state.older = [...byId.values()]; state.nextBeforeId = data.nextBeforeId; return true;
    } catch { if (generation === historyGeneration) state.historyError = 'Older messages could not be loaded. Current records are kept.'; return false; }
    finally { if (generation === historyGeneration) { state.historyLoading = false; emit(); } }
  }
  return { getState: () => state, refresh, editEntry, editProfile, addEntry, removeEntry, reloadBank, saveBank, cancel, canSave, choose, loadHistory,
    start() { if (timer === null) { void refresh(); timer = setIntervalImpl(() => { if (state.network === 'online' && !directorFresh(state, now())) { state.network = 'stale'; emit(); } void refresh(); }, POLL_MS); } },
    stop() { if (timer !== null) clearIntervalImpl(timer); timer = null; } };
}

const element = (document, tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
function value(node, next) { if (node.value !== next) node.value = next; }
function options(document, node, entries) { node.replaceChildren(...entries.map(([id, text]) => { const option = element(document, 'option', text); option.value = id; return option; })); }
function field(document, label, input) { const node = element(document, 'label', label); node.append(input); return node; }
function button(document, text, action, className = '') { const node = element(document, 'button', text, className); node.type = 'button'; node.addEventListener('click', action); return node; }
function pill(document, text, tone = 'muted') { const node = element(document, 'span', text, 'pill'); node.setAttribute('data-tone', tone); return node; }
const clock = value => { const at = stamp(value); return Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : 'Time unavailable'; };
const STATUS = { planned: 'Waiting', offered: 'Waiting for account', generating: 'Preparing reply', held: 'On hold', waiting: 'Waiting', reserved: 'Turn reserved', leased: 'Turn reserved', submitting: 'Sending · unconfirmed', pending: 'Pending · unconfirmed', confirmed: 'Delivery confirmed', rejected: 'Delivery rejected', cancelled: 'Cancelled before submission', expired: 'Expired', unknown: 'Delivery uncertain · no retry', no_match: 'No matching reply · nothing sent' };
export function timelineRow(document, row, { plan = false, canCancel = false, cancel = () => {} } = {}) {
  const node = element(document, 'li'), state = plan ? row.state : row.delivery;
  const top = element(document, 'div', undefined, 'timeline-top');
  top.append(element(document, 'strong', row.account ? `@${safe(row.account)}` : known(NAMES, row.accountId, 'Account unavailable')), pill(document, known(STATUS, state, 'Delivery unverified'), state === 'confirmed' ? 'good' : ['unknown', 'rejected'].includes(state) ? 'warn' : 'muted'));
  node.append(top, element(document, 'p', `${row.channel ? '#' + safe(row.channel) : 'Channel unavailable'} · ${known(KINDS, row.kind, 'Message')}`, 'timeline-route'));
  if (row.kind === 'event') node.append(element(document, 'p', `${known(EVENT_NAMES, row.event?.type || row.category, 'Chat event')}${row.event?.at ? ' · observed ' + clock(row.event.at) : ''}`, 'message-detail'));
  const available = row.textAvailable !== false && typeof row.text === 'string' && row.text.length > 0;
  node.append(element(document, 'p', available ? row.text : plan ? 'Message wording is being prepared.' : 'Text unavailable in this historical record.', 'message-body'));
  if (row.reason) node.append(element(document, 'p', safe(row.reason), 'message-detail'));
  if (row.replyTo) node.append(element(document, 'p', `Reply to ${safe(row.replyTo)}`, 'message-detail'));
  if (row.source === 'legacy') node.append(element(document, 'span', 'Imported history · original outcome retained', 'timeline-provenance'));
  node.append(element(document, 'p', plan ? `Eligible after ${clock(row.notBefore)} · expires ${clock(row.expiresAt)}` : clock(row.at), 'timeline-time'));
  if (plan && row.cancellable === true) { const action = button(document, 'Cancel pending message', () => cancel(row.planId), 'subtle timeline-cancel'); action.disabled = !canCancel; node.append(action); }
  return node;
}
export function historyRows(state, accountId = 'all') {
  const head = Object.hasOwn(state, 'historyHead') ? state.historyHead : state.data?.history;
  const byId = new Map([...rows(state.older), ...rows(head)].map(row => [row.id, row]));
  return [...byId.values()].filter(row => accountId === 'all' || row.accountId === accountId).sort((a, b) => stamp(b.at) - stamp(a.at) || Number(b.id) - Number(a.id));
}
export function accountSummary(data, accountId) {
  const profile = rows(data?.profiles).find(profile => profile.id === accountId) || rows(data?.bank?.profiles).find(profile => profile.id === accountId);
  const assigned = rows(data?.bank?.entries).filter(entry => entry.enabled === true && rows(entry.accountIds).includes(accountId));
  if (!profile) return 'Central account settings are unavailable.';
  return `${profile.chatMode === 'participate' ? 'Occasional participation' : 'Replies to mentions'} · ${profile.replySource === 'ai' ? 'AI replies' : 'Bank replies'} · ${assigned.length} enabled message groups`;
}

export function createMessagesView(document, controller) {
  const ids = ['messages-network', 'messages-notice', 'messages-access', 'director-readiness', 'tab-bank', 'tab-outgoing', 'bank-panel', 'outgoing-panel', 'director-profiles', 'bank-revision', 'bank-entries', 'bank-add', 'bank-save', 'bank-reload', 'bank-feedback', 'bank-validation', 'bank-kind-filter', 'bank-account-filter', 'history-account', 'messages-refresh', 'outgoing-count', 'director-outgoing', 'director-history-count', 'director-history', 'history-more', 'history-feedback', 'messages-refreshed'];
  const nodes = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  if (ids.some(id => !nodes[id])) throw Error('Messages interface is incomplete.');
  const view = { document, nodes, entries: new Map(), profiles: new Map(), order: '' };
  nodes['tab-bank'].addEventListener('click', () => controller.choose('tab', 'bank'));
  nodes['tab-outgoing'].addEventListener('click', () => controller.choose('tab', 'outgoing'));
  for (const id of ['tab-bank', 'tab-outgoing']) nodes[id].addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'bank' : event.key === 'End' ? 'outgoing' : id === 'tab-bank' ? 'outgoing' : 'bank';
    controller.choose('tab', next); nodes[`tab-${next}`].focus?.();
  });
  for (const [id, fieldName] of [['bank-kind-filter', 'kindFilter'], ['bank-account-filter', 'bankAccount'], ['history-account', 'historyAccount']]) nodes[id].addEventListener('change', () => controller.choose(fieldName, nodes[id].value));
  nodes['bank-add'].addEventListener('click', () => controller.addEntry()); nodes['bank-save'].addEventListener('click', () => void controller.saveBank()); nodes['bank-reload'].addEventListener('click', () => controller.reloadBank());
  nodes['messages-refresh'].addEventListener('click', () => void controller.refresh()); nodes['history-more'].addEventListener('click', () => void controller.loadHistory());
  return view;
}
function entryView(view, entry, controller) {
  const { document } = view, card = element(document, 'article', undefined, 'bank-entry'), heading = element(document, 'h3', 'Message group');
  const top = element(document, 'div', undefined, 'bank-entry-header'); top.append(heading, button(document, 'Remove group', () => controller.removeEntry(entry.id), 'subtle'));
  const kind = element(document, 'select'); kind.setAttribute('aria-label', 'Message kind'); options(document, kind, MESSAGE_KINDS.map(id => [id, KINDS[id]])); kind.addEventListener('change', () => controller.editEntry(entry.id, 'kind', kind.value));
  const category = element(document, 'select'); category.setAttribute('aria-label', 'Message category'); category.addEventListener('change', () => controller.editEntry(entry.id, 'category', category.value));
  const categoryField = field(document, 'Category', category), fields = element(document, 'div', undefined, 'entry-fields'); fields.append(field(document, 'Kind', kind), categoryField);
  const lines = element(document, 'textarea'); lines.rows = 5; lines.setAttribute('aria-label', 'Message options, one per line'); lines.addEventListener('input', () => controller.editEntry(entry.id, 'lines', lines.value));
  const textField = field(document, 'Options · one per line', lines); textField.className = 'entry-text';
  const help = element(document, 'p', undefined, 'field-note entry-help');
  const assignments = element(document, 'fieldset', undefined, 'entry-assignment'); assignments.append(element(document, 'legend', 'Used by'));
  const accounts = {};
  for (const id of ACCOUNT_IDS) {
    const input = element(document, 'input'); input.type = 'checkbox'; input.addEventListener('change', () => controller.editEntry(entry.id, 'accountIds', ACCOUNT_IDS.filter(id => accounts[id].checked)));
    const label = element(document, 'label', undefined, 'check-label'); label.append(input, element(document, 'span', NAMES[id])); assignments.append(label); accounts[id] = input;
  }
  const enabled = element(document, 'input'); enabled.type = 'checkbox'; enabled.addEventListener('change', () => controller.editEntry(entry.id, 'enabled', enabled.checked));
  const enabledField = element(document, 'label', undefined, 'check-label entry-enabled'); enabledField.append(enabled, element(document, 'span', 'Enabled for future decisions'));
  card.append(top, fields, textField, help, assignments, enabledField); return { card, heading, kind, category, categoryField, lines, help, accounts, enabled, categoryKind: '' };
}
function renderEditor(view, state, controller, now) {
  const { document, nodes } = view;
  for (const profile of rows(state.bank?.profiles)) {
    let item = view.profiles.get(profile.id);
    if (!item) {
      const card = element(document, 'div', undefined, 'director-profile'), title = element(document, 'h3', known(NAMES, profile.id, 'Account'));
      const mode = element(document, 'select'), source = element(document, 'select');
      options(document, mode, [['mentions', 'Reply to mentions'], ['participate', 'Participate occasionally']]); options(document, source, [['local', 'Bank replies'], ['ai', 'AI replies']]);
      mode.addEventListener('change', () => controller.editProfile(profile.id, 'chatMode', mode.value)); source.addEventListener('change', () => controller.editProfile(profile.id, 'replySource', source.value));
      const detail = element(document, 'p', undefined, 'field-note'); card.append(title, field(document, 'Conversation mode', mode), field(document, 'Reply source', source), detail); nodes['director-profiles'].append(card);
      item = { card, mode, source, detail }; view.profiles.set(profile.id, item);
    }
    value(item.mode, profile.chatMode); value(item.source, profile.replySource);
    const live = rows(state.data?.profiles).find(item => item.id === profile.id);
    item.detail.textContent = live?.ready === true ? 'Central account history is ready.' : safe(live?.reason) || 'Waiting for this account’s history.';
    if (live?.imports) item.detail.textContent += ` Saved messages: ${live.imports.helper === true ? 'received' : 'waiting'}. Browser history: ${live.imports.browser === true ? 'received' : 'waiting'}.`;
  }
  for (const entry of rows(state.bank?.entries)) {
    let item = view.entries.get(entry.id);
    if (!item) { item = entryView(view, entry, controller); view.entries.set(entry.id, item); }
    item.heading.textContent = `${known(KINDS, entry.kind, 'Message')} · ${entry.lines.length} ${entry.kind === 'exchange' ? 'lines' : 'options'}`;
    value(item.kind, entry.kind); value(item.lines, entry.lines.join('\n')); item.enabled.checked = entry.enabled === true;
    for (const id of ACCOUNT_IDS) item.accounts[id].checked = rows(entry.accountIds).includes(id);
    item.categoryField.hidden = !['reply', 'topic', 'event'].includes(entry.kind);
    if (item.categoryKind !== entry.kind) {
      const categories = entry.kind === 'reply' ? REPLY_CATEGORIES : entry.kind === 'topic' ? TOPIC_CATEGORIES : entry.kind === 'event' ? EVENT_CATEGORIES : [''];
      options(document, item.category, categories.map(id => [id, entry.kind === 'event' ? EVENT_NAMES[id] : id || 'General'])); item.categoryKind = entry.kind;
    }
    // A saved category remains visible even when an older client does not know it.
    if (entry.category && !Array.from(item.category.options || []).some(option => option.value === entry.category) && ![...REPLY_CATEGORIES, ...TOPIC_CATEGORIES].includes(entry.category)) { const option = element(document, 'option', entry.category); option.value = entry.category; item.category.append(option); }
    value(item.category, entry.category);
    item.help.textContent = entry.kind === 'exchange' ? 'Exactly two lines. Write the scene text; the partner mention is added when a pair is chosen. Editing does not clear consumed scenes.' : entry.kind === 'event' ? 'Short reactions to verified chat events. One eligible companion reacts, within normal limits. Write as a viewer; no names, amounts or substitutions are added.' : entry.kind === 'topic' ? '1–16 options. Use {game} for the current category. Each option is at most 260 characters.' : entry.kind === 'reply' ? '1–16 options. Metadata replies may use {game} or {title}. Each option is at most 260 characters.' : '1–16 options, at most 260 characters each. A saved change does not reset an attempted greeting.';
    item.card.hidden = state.kindFilter !== 'all' && state.kindFilter !== entry.kind || state.bankAccount !== 'all' && !entry.accountIds.includes(state.bankAccount);
  }
  const ids = rows(state.bank?.entries).map(entry => entry.id), order = JSON.stringify(ids);
  if (order !== view.order) { nodes['bank-entries'].replaceChildren(...(ids.length ? ids.map(id => view.entries.get(id).card) : [element(document, 'p', 'No message groups. Add a group before saving.', 'empty')])); view.order = order; }
  for (const id of view.entries.keys()) if (!ids.includes(id)) view.entries.delete(id);
  nodes['bank-revision'].textContent = state.baseRevision === null ? 'Waiting for bank' : `Saved version ${state.baseRevision}`;
  nodes['bank-feedback'].textContent = state.error || state.feedback || (state.dirty ? 'Unsaved changes.' : 'Saved bank loaded.');
  nodes['bank-validation'].textContent = state.conflict ? 'A newer saved bank is available. Your edits are preserved.' : state.bank ? bankValidation(state.bank) : '';
  nodes['bank-save'].disabled = !controller.canSave(); nodes['bank-save'].textContent = state.mutation?.kind === 'bank' ? 'Checking save outcome…' : 'Save message bank';
  nodes['bank-reload'].disabled = !directorFresh(state, now) || state.mutation?.transport === true || state.mutation && state.mutation.kind !== 'bank' || !(state.dirty || state.conflict || state.mutation);
  nodes['bank-add'].disabled = !state.bank || state.bank.entries.length >= 160;
}
export function renderMessages(view, state, controller, now = Date.now()) {
  const { document, nodes } = view, current = directorFresh(state, now);
  nodes['messages-network'].textContent = networkTitle(current ? 'online' : state.network, state.basePath); nodes['messages-network'].setAttribute('data-tone', current ? 'good' : 'warn');
  nodes['messages-notice'].hidden = current || state.network === 'loading'; nodes['messages-notice'].textContent = connectionMessage(state.network, state.basePath, !!state.data);
  nodes['messages-access'].hidden = !state.basePath || !['unauthenticated', 'forbidden'].includes(state.network);
  nodes['director-readiness'].textContent = !current ? 'Central message status is unverified. Automatic messages wait for a fresh controller.' : state.data?.ready ? 'Central message control is ready. Each account still needs Start and eligible live playback.' : safe(state.data?.reason) || 'Waiting for account history before central automatic messages can run.';
  nodes['tab-bank'].setAttribute('aria-selected', String(state.tab === 'bank')); nodes['tab-outgoing'].setAttribute('aria-selected', String(state.tab === 'outgoing'));
  nodes['tab-bank'].tabIndex = state.tab === 'bank' ? 0 : -1; nodes['tab-outgoing'].tabIndex = state.tab === 'outgoing' ? 0 : -1;
  nodes['bank-panel'].hidden = state.tab !== 'bank'; nodes['outgoing-panel'].hidden = state.tab !== 'outgoing';
  value(nodes['bank-kind-filter'], state.kindFilter); value(nodes['bank-account-filter'], state.bankAccount); value(nodes['history-account'], state.historyAccount);
  renderEditor(view, state, controller, now);
  const plans = rows(state.data?.plans).filter(plan => state.historyAccount === 'all' || plan.accountId === state.historyAccount);
  nodes['outgoing-count'].textContent = `${plans.length} shown`; nodes['director-outgoing'].replaceChildren(...(plans.length ? plans.map(plan => timelineRow(document, plan, { plan: true, canCancel: current && !state.mutation, cancel: controller.cancel })) : [element(document, 'li', 'No pending central messages.', 'empty')]));
  const history = historyRows(state, state.historyAccount); nodes['director-history-count'].textContent = `${history.length} shown`;
  const historyEmpty = state.historyHead && !state.historyHeadError ? 'No delivery records for this account.' : 'Waiting for delivery history.';
  nodes['director-history'].replaceChildren(...(history.length ? history.map(row => timelineRow(document, row)) : [element(document, 'li', historyEmpty, 'empty')]));
  nodes['history-more'].disabled = !current || state.historyLoading || state.nextBeforeId === null; nodes['history-more'].textContent = state.historyLoading ? 'Loading older messages…' : 'Load older messages';
  nodes['history-feedback'].textContent = state.historyHeadError || state.historyError || (state.historyHead && !state.historyLoading && state.nextBeforeId === null ? 'No older retained messages.' : '');
  nodes['messages-refreshed'].textContent = state.data ? `Host refreshed ${clock(state.data.updatedAt)}` : 'Waiting for status';
}

export function renderAccountDirector(document, state, accountId, now = Date.now()) {
  const summary = document.getElementById('central-message-settings'), notice = document.getElementById('central-message-notice');
  const list = document.getElementById('delivery-history'), count = document.getElementById('sent-count');
  if (!summary || !notice || !list || !count) return;
  const current = directorFresh(state, now);
  summary.textContent = state.data ? accountSummary(state.data, accountId) : 'Waiting for central message settings.';
  const profile = rows(state.data?.profiles).find(profile => profile.id === accountId);
  notice.textContent = !current ? connectionMessage(state.network, state.basePath, !!state.data) || 'Central message status is unverified.' : state.historyHeadError || (profile?.ready === false ? safe(profile.reason) || 'Waiting for this account’s imported history.' : 'These settings and assignments are managed in the shared message bank.');
  const history = historyRows(state, accountId); count.textContent = `${history.length} central records`;
  list.replaceChildren(...(history.length ? history.map(row => timelineRow(document, row)) : [element(document, 'li', current && state.historyHead && !state.historyHeadError ? 'No central delivery records for this account.' : 'Waiting for central delivery history.', 'empty')]));
}

if (globalThis.document) {
  const document = globalThis.document, fullPage = document.querySelector('[data-messages-app]');
  const basePath = basePathFromModule(import.meta.url), match = new RegExp(`^${basePath}/accounts/(primary|test|third|fourth)/?$`).exec(globalThis.location.pathname), overview = globalThis.location.pathname === `${basePath}/accounts`;
  if (fullPage || match || overview) {
    let view; const controller = createDirectorController({ basePath, publishProfiles: true, historyAccount: match?.[1] || 'all', onState: state => { if (fullPage) renderMessages(view, state, controller); else if (match) renderAccountDirector(document, state, match[1]); } });
    if (fullPage) { view = createMessagesView(document, controller); configureControllerMount(document, basePath); }
    bindControllerLifecycle(controller); controller.start();
  }
}
