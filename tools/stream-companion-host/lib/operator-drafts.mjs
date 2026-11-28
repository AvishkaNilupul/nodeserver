import { validateCommand } from './accounts.mjs';
import { validateReply } from './text-policy.mjs';

const profiles = new Set(['primary', 'test', 'third', 'fourth']);
const bots = new Set(['nightbot', 'moobot', 'streamelements', 'streamlabs', 'fossabot', 'wizebot', 'botisimo', 'commanderroot', 'sery_bot', 'serybot', 'soundalerts', 'pretzelrocks', 'tmi', 'jtv']);
const login = value => typeof value === 'string' && /^[a-z0-9_]{3,25}$/.test(value);
const messageId = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(value);
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const targetAge = 120_000, historyAge = 300_000, jobTimeout = 30_000, retention = 300_000;
const modelErrors = {
  invalid_draft: 'The model returned an unusable draft. Request another draft.',
  model_unavailable: 'The on-device draft model is unavailable.',
  model_timeout: 'Draft generation timed out. Request another draft.'
};
const safeText = value => typeof value === 'string' && !!value.trim() && value.length <= 500
  && !/^\s*[!/.]|[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|\[redacted\]/iu.test(value)
  && !/(?:[\p{L}0-9-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,63})\b|\b[a-z][a-z0-9+.-]*:\/\//iu.test(value);
const fresh = (value, time, span) => {
  const at = typeof value === 'string' ? Date.parse(value) : value;
  return Number.isFinite(at) && at <= time + 5000 && at >= time - span;
};

function unavailable(instance, time) {
  if (!instance?.available || !fresh(instance.checkedAt, time, 45_000)) return 'The companion status is unavailable or out of date. Refresh the account before drafting.';
  if (instance.settings?.paused !== false || instance.controls?.pending?.action === 'stop') return 'The account is stopped or stopping.';
  if (!instance.authorized || !instance.connected || !login(instance.account)) return 'Reconnect the account to Twitch chat before drafting.';
  if (!login(instance.channel) || instance.settings.allowedChannel !== instance.channel) return 'The connected chat does not match the configured channel.';
  if (!instance.browser?.online || !fresh(instance.browser.lastSeenAt, time, 45_000)) return 'The account browser is offline or out of date.';
  return '';
}

function streamId(instance) {
  const stream = instance.streamContext;
  return stream?.isLive && stream.channel === instance.channel && messageId(stream.streamId) ? stream.streamId : '';
}

const mentions = m => [...m.text.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_]{3,25})(?![a-z0-9_])/gi)].map(match => match[1].toLowerCase());

function selectConversation(instance, companions, time) {
  const { account, channel } = instance;
  const incoming = instance.chat.messages.filter(m => m.channel === channel && messageId(m.id) && login(m.author)
    && !companions.has(m.author) && !bots.has(m.author) && !m.author.endsWith('bot') && !m.isBot && !m.bot
    && m.at >= time - historyAge && m.at <= time && safeText(m.text)).sort((a, b) => a.at - b.at);
  const confirmed = instance.sent.filter(m => m.account === account && m.channel === channel && m.delivery === 'confirmed'
    && Number.isFinite(m.at) && m.at <= time && safeText(m.text)).map(m => ({ id: m.messageId, author: account, text: m.text, at: m.at, replyTo: m.replyTo }));
  const own = new Map(confirmed.filter(m => messageId(m.id)).map(m => [m.id, m]));
  const recentOwnReply = m => confirmed.filter(parent => parent.replyTo === m.author && parent.at <= m.at && parent.at >= m.at - 90_000)
    .sort((a, b) => b.at - a.at)[0];
  const byId = new Map(incoming.map(m => [m.id, m]));
  // An unrecognized native parent might belong to a different conversation.
  // Carry a thread only along the same viewer's messages or a confirmed own send.
  function ancestry(m) {
    const path = [], visited = new Set([m.id]);
    while (m.replyParentId) {
      const parent = own.get(m.replyParentId) || byId.get(m.replyParentId);
      if (!parent || parent.at > m.at || visited.has(m.replyParentId)) return null;
      if (parent.author === account) return [parent, ...path];
      if (parent.author !== m.author || path.length >= 5) return null;
      visited.add(parent.id);
      path.unshift(parent);
      m = parent;
    }
    return path;
  }

  const lastDirect = new Map();
  let selected;
  for (const m of incoming) {
    const addressees = mentions(m), path = ancestry(m);
    if (!path || addressees.some(name => name !== account)) continue;
    const direct = addressees.includes(account) || path.some(parent => parent.author === account || mentions(parent).includes(account));
    const previous = lastDirect.get(m.author);
    const followUp = previous && m.at - previous.m.at <= 60_000;
    if (direct) lastDirect.set(m.author, { m, path });
    if (m.at < time - targetAge) continue;
    const ownReply = !m.replyParentId && recentOwnReply(m);
    const priority = direct || followUp || ownReply ? 1 : 0;
    if (!selected || priority >= selected.priority) {
      // A clarifying unthreaded line can follow the viewer's earlier native reply.
      // Keep that verified branch, including the actual parent the viewer answered.
      const branch = !path.length && !direct && followUp && previous.path.length
        ? [...previous.path, previous.m] : path;
      selected = { m, path: branch, priority, ownReply };
    }
  }
  if (!selected) throw failure('There is no recent viewer message to reply to in this channel.');
  const { m: target, path, ownReply } = selected;
  const earlier = incoming.slice(0, incoming.indexOf(target)).filter(m => m.at >= target.at - targetAge
    && m.author === target.author && !m.replyParentId && mentions(m).every(name => name === account)).slice(-4);
  const contextRows = [...earlier, ...path];
  if (ownReply) contextRows.push(ownReply);
  const messages = [...new Set(contextRows)].sort((a, b) => a.at - b.at).map(m => ({ author: m.author, text: m.text }));
  const stream = instance.streamContext;
  const thread = new Set([target.id, target.replyParentId, ...path.map(m => m.id)].filter(messageId));
  return { target, thread, context: { account, channel, target: { author: target.author, text: target.text }, messages,
    stream: stream?.isLive && stream.channel === channel && fresh(stream.checkedAt, time, 120_000)
      ? { title: safeText(stream.title) ? stream.title : '', category: safeText(stream.gameName) ? stream.gameName : '' } : null } };
}

function hasNewerFollowUp(job, instance, time) {
  const messages = instance.chat.messages;
  const originalIndex = messages.findIndex(m => m.id === job.targetId && m.channel === job.channel && m.author === job.targetAuthor);
  return messages.some((m, index) => {
    if (m.author !== job.targetAuthor || m.channel !== job.channel || m.id === job.targetId || !messageId(m.id)
      || m.at < job.targetAt || m.at === job.targetAt && index <= originalIndex || m.at > time
      || m.isBot || m.bot || !safeText(m.text)) return false;
    const addressees = mentions(m);
    if (addressees.some(name => name !== job.account)) return false;
    if (!m.replyParentId) return addressees.includes(job.account) || m.at - job.targetAt <= 60_000;
    return job.thread.has(m.replyParentId);
  });
}

export function createOperatorDrafts({ snapshot, generate, companionLogins = [], now = Date.now }) {
  const jobs = new Map(), epochs = new Map();
  const configured = new Set(companionLogins.filter(login));
  let closed = false;

  function finish(job, state, error, result) {
    clearTimeout(job.timer);
    job.command = { ...job.command, state, error };
    if (result) job.command.result = result;
    else delete job.command.result;
    if (state !== 'completed') job.controller.abort();
  }

  function history(id) {
    const entries = jobs.get(id) || [];
    const retained = entries.filter(job => now() - job.command.createdAt < retention);
    for (const job of entries) {
      if (job.command.state === 'running' && now() >= job.command.expiresAt) finish(job, 'expired', modelErrors.model_timeout);
    }
    if (retained.length) jobs.set(id, retained);
    else jobs.delete(id);
    return retained;
  }

  function reconcile(job, instance, companions) {
    if (!['running', 'completed'].includes(job.command.state)) return;
    if (job.command.state === 'running' && now() >= job.command.expiresAt) {
      finish(job, 'expired', modelErrors.model_timeout);
      return;
    }
    const { account, channel, targetId, targetAuthor, targetAt } = job;
    const stop = instance?.controls?.recent?.some(c => c.action === 'stop' && c.createdAt >= job.command.createdAt);
    const targetPresent = instance?.chat?.messages?.some(m => m.id === targetId && m.author === targetAuthor && m.channel === channel && m.at === targetAt && m.text === job.targetText && m.replyParentId === job.parentId && !m.isBot && !m.bot);
    if (unavailable(instance, now()) || instance.account !== account || instance.channel !== channel || stop || instance.controls?.pending
      || !companions || companions.has(targetAuthor) || job.streamId && job.streamId !== streamId(instance) || !targetPresent || now() - targetAt > targetAge) {
      finish(job, 'cancelled', 'The account, channel, or viewer conversation changed. Request a fresh draft.');
    } else if (hasNewerFollowUp(job, instance, now())) {
      finish(job, 'cancelled', 'A newer message from @' + targetAuthor + ' changed the conversation. Request a fresh draft.');
    }
  }

  function companionsFor(instances) {
    if (instances.some(i => !login(i.account)) && configured.size < instances.length) return null;
    return new Set([...configured, ...instances.map(i => i.account).filter(login)]);
  }

  async function generateDraft(job, context) {
    try {
      const raw = await generate(context, { signal: job.controller.signal });
      if (job.command.state !== 'running') return;
      let text;
      try { text = validateReply(raw); } catch { /* Report validation failures without including model text. */ }
      if (!safeText(text)) {
        finish(job, 'failed', modelErrors.invalid_draft);
        return;
      }
      const { instances } = await snapshot();
      if (job.command.state !== 'running') return;
      const instance = instances.find(i => i.id === job.id);
      reconcile(job, instance, companionsFor(instances));
      if (job.command.state !== 'running') return;
      finish(job, 'completed', '', { text, reason: 'Draft reply to @' + job.targetAuthor + '.', account: job.account, channel: job.channel, targetAuthor: job.targetAuthor, ...(job.streamId ? { streamId: job.streamId } : {}) });
    } catch (error) {
      if (job.command.state === 'running') finish(job, 'failed', Object.hasOwn(modelErrors, error?.code)
        ? modelErrors[error.code] : 'The draft could not be generated. Refresh the account and check the on-device model.');
    }
  }

  function invalidate(id) {
    if (!profiles.has(id)) return;
    epochs.set(id, (epochs.get(id) || 0) + 1);
    for (const job of history(id)) if (['running', 'completed'].includes(job.command.state)) finish(job, 'cancelled', 'The account was stopped or changed. Request a fresh draft.');
  }

  async function request(id, input) {
    const body = validateCommand(input);
    if (body.action !== 'draft' || body.params.mode !== 'reply') throw failure('Choose Draft reply to request a reviewed draft.', 400);
    if (!profiles.has(id)) throw failure('Unknown companion.', 404);
    if (closed) throw failure('The draft service is offline.', 503);
    const epoch = epochs.get(id);
    let instances;
    try { ({ instances } = await snapshot()); } catch { throw failure('The companion status is unavailable.', 503); }
    if (closed || epoch !== epochs.get(id)) throw failure('The account changed while loading. Request a fresh draft.');
    const instance = instances.find(i => i.id === id);
    if (!instance) throw failure('The companion status is unavailable.', 503);
    const companions = companionsFor(instances);
    const entries = history(id);
    for (const job of entries) reconcile(job, instance, companions);
    const prior = entries.find(job => job.command.requestId === body.requestId);
    if (prior) return { ok: true, command: prior.command };
    const issue = unavailable(instance, now());
    if (issue) throw failure(issue);
    if (instance.controls?.pending || entries.some(job => job.command.state === 'running')) throw failure('Another account operation is in progress. Wait for it to finish.');
    if (instance.controls?.recent?.some(c => c.requestId === body.requestId)) throw failure('That request ID was already used for an account operation.');
    if (entries.length >= 30) throw failure('Too many recent draft requests. Wait before requesting another draft.', 429);
    if (!companions) throw failure('Companion identities are unavailable. Refresh the account list before drafting.');
    const { target, thread, context } = selectConversation(instance, companions, now());
    const createdAt = now(), command = { id: 'review:' + body.requestId, ...body, state: 'running', createdAt, expiresAt: createdAt + jobTimeout, error: '' };
    const job = { id, command, thread, account: instance.account, channel: instance.channel, streamId: streamId(instance),
      targetId: target.id, targetAuthor: target.author, targetAt: target.at, targetText: target.text, parentId: target.replyParentId, controller: new AbortController() };
    job.timer = setTimeout(() => { if (job.command.state === 'running') finish(job, 'expired', modelErrors.model_timeout); }, jobTimeout);
    job.timer.unref();
    jobs.set(id, [job, ...entries]);
    void generateDraft(job, context);
    return { ok: true, command };
  }

  function decorate(instance, peers) {
    const entries = history(instance.id);
    if (!entries.length) return instance;
    const companions = peers ? companionsFor(peers) : configured;
    for (const job of entries) reconcile(job, instance, companions);
    const commands = entries.map(job => job.command);
    return { ...instance, controls: { ...instance.controls, pending: instance.controls?.pending || commands.find(c => c.state === 'running') || null,
      recent: [...(instance.controls?.recent || []), ...commands].sort((a, b) => b.createdAt - a.createdAt) } };
  }

  function stop() {
    closed = true;
    for (const id of profiles) invalidate(id);
  }
  return { request, decorate, invalidate, stop };
}
