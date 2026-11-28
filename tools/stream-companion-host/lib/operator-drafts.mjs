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

const roomAddresses = new Set(['chat', 'everyone', 'everybody', 'folks', 'guys', 'all', 'anyone', 'anybody', 'friends']);
// A name before punctuation can be a conversational cue instead ("Actually, did you…?").
const discourseCues = new Set(['actually', 'again', 'also', 'alright', 'anyway', 'anyways', 'basically', 'but', 'cool', 'dang', 'first', 'honestly', 'huh', 'instead', 'later', 'like', 'lol', 'look', 'man', 'maybe', 'next', 'nice', 'now', 'okay', 'otherwise', 'please', 'quick', 'really', 'right', 'seriously', 'so', 'sorry', 'sure', 'thanks', 'then', 'though', 'today', 'tomorrow', 'tonight', 'wait', 'well', 'wow', 'yeah', 'yesterday']);
const leadingAddress = /^(?:(hey|hi|hello|yo)[,，]?\s+)?([a-z0-9_]{3,25})(?=\s*[,，:：]|\s+(?:(?:what|which|where|who|why|when|how)\b|(?:can|could|did|do|would|are|have)\s+you\b))/i;
const trailingAddress = /[,，]\s*([a-z0-9_]{3,25})\s*[?？!！.]*$/i;
const personalQuestion = /\b(?:did|do|can|could|would|will|are|were|have|had|should)\s+you\b|\b(?:what|which|how|where)\b[^,，:：?]{0,50}\byour\b/i;
const pairedAddress = /^(?:hey\s+)?([a-z0-9_]{3,25})(?:\s+and\s+|\s*[,，&]\s*)([a-z0-9_]{3,25})\s*[,，:：]/i;
function roomNames(instance, companions) {
  const names = new Set([...companions, instance.channel]);
  for (const m of instance.chat.messages) if (m.channel === instance.channel && login(m.author)) names.add(m.author);
  return names;
}
function addressees(text, names) {
  const found = new Set([...text.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_]{3,25})(?![a-z0-9_])/gi)].map(match => match[1].toLowerCase()));
  const line = text.trim(), first = leadingAddress.exec(line), last = trailingAddress.exec(line);
  const lead = first?.[2].toLowerCase(), tail = last?.[1].toLowerCase();
  const pair = pairedAddress.exec(line);
  if (pair) {
    const group = pair.slice(1).map(name => name.toLowerCase());
    if (group.every(name => names.has(name) && !roomAddresses.has(name))) group.forEach(name => found.add(name));
  }
  // A greeting identifies its recipient even on first sight. For a bare, unseen
  // name require both address punctuation and a question clearly directed at "you".
  if (lead && !roomAddresses.has(lead) && (names.has(lead) || first[1] ||
    !discourseCues.has(lead) && /^\s*[,，:：]/.test(line.slice(first[0].length)) && personalQuestion.test(line))) found.add(lead);
  if (tail && !roomAddresses.has(tail) && (names.has(tail) || !discourseCues.has(tail) && personalQuestion.test(line))) found.add(tail);
  return [...found];
}

// A room-wide remark needs an actual opening for a reply. Direct mentions and
// verified native replies have their own evidence of conversational intent.
const questionMark = /[?¿؟՞፧⁇⁈⁉﹖？]/u;
const requestForms = [
  /^(?:any(?:one|body)\s+(?:know|remember|have|up for)|any\s+(?:tips|ideas|advice|recommendations))\b/iu,
  /^(?:(?:please\s+)?(?:tell|show|teach|remind|help)\s+(?:me|us)|(?:please|pls)\s+(?:explain|help|show|share)|walk (?:me|us) through|recommend (?:a|an|some))\b/iu,
  /^(?:can|could|would|should|will|did|do|does|is|are|was|were|has|have)\s+(?:you|we|i|anyone|someone|this|that|there|the)\b/iu,
  /^(?:let['’]?s\s+(?:vote|pick|choose)|who['’]?s\s+up for|who wants to|join (?:me|us) (?:for|in))\b/iu,
  /^(?:(?:what|where|who|how|when)['’]s|(?:what|which|where|who|why|how|when)\s+(?:is|are|was|were|did|does|do|can|could|should|would|has|happened|happens|many|much|far|long|about|time|lap|map|game|mode|gear|route))\b/iu,
  /^(?:(?:alguien|algui[eé]m)\s+(?:sabe|puede|pode)|(?:quelqu['’]un|qualcuno)\s+(?:sait|peut|sa|può)|est-ce que|kann (?:mir |uns )?jemand|кто знает|подскажите|объясните)(?:\s|$)/iu,
  /(?:どうやって|教えて(?:ください)?[。！]?$|ですか[。！]?$|[吗嗎][。！]?$|怎么|怎麼|어떻게|나요[.!]?$)/u
];
const correction = /^(?:(?:actually[, ]+)?i (?:meant|mean|was asking|was talking about)|(?:no|sorry|actually)[, ]+(?:the |that |i meant|i mean)|(?:the|that) other\b|me refer[ií]a|quer[ií]a decir|je voulais dire|ich meinte|я (?:имел|имела) в виду|違う|不是)/iu;
const acknowledgement = /^(?:no[, ]|yes\b|yeah\b|yep\b|nope\b|sorry[, ]|my bad\b|that(?:'s|’s| is) (?:it|right|what i meant)|thanks\b|thank you\b|そう(?:です|そう)|对的|네[ ,.!]|아니)/iu;
function invitesReply(text) {
  const line = text.trim().replace(/^(?:hey\s+)?(?:chat|everyone|folks|guys)[,:]?\s+/iu, '');
  if (!/\p{L}/u.test(line) || /^(?:lol+|lmao+|kekw|gg|wow|bruh)[\s!?！？]+$/iu.test(line)) return false;
  return questionMark.test(line) || requestForms.some(form => form.test(line));
}
function continuesTurn(text, direct) {
  return correction.test(text) || direct && acknowledgement.test(text);
}
function personalInsult(text) {
  // A viewer can quote abuse or ask for help with moderation without endorsing it.
  if (/\b(?:called|calls|call|calling)\s+(?:me|us)\b/iu.test(text)
    || /\b(?:how (?:do|can|could|should) (?:i|we|you)|how to|can (?:i|we)|help (?:me|us))\b[^.!?]{0,50}\b(?:mute|block|report|ignore|filter|deal with)\b/iu.test(text)) return false;
  return /\b(?:idiots?|morons?|dumbasses?|assholes?|douchebags?|scumbags?)\b/i.test(text)
    || /\b(?:guys?|people|players?|streamers?|dudes?|they|you|he|she|who|what|such|those|these)\b[^.!?]{0,42}\b(?:jerks?|losers?|stupid|pathetic|worthless)\b/i.test(text)
    || /\b(?:why|how)\s+(?:are|is)\b[^.!?]{0,32}\b(?:jerks?|losers?)\b/i.test(text);
}

function selectConversation(instance, companions, time) {
  const { account, channel } = instance;
  const names = roomNames(instance, companions);
  const incoming = instance.chat.messages.filter(m => m.channel === channel && messageId(m.id) && login(m.author)
    && !companions.has(m.author) && !bots.has(m.author) && !m.author.endsWith('bot') && !m.isBot && !m.bot
    && m.at >= time - historyAge && m.at <= time && safeText(m.text) && !personalInsult(m.text)).sort((a, b) => a.at - b.at);
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
      if (parent.author !== m.author || path.length >= 5 || addressees(parent.text, names).some(name => name !== account)) return null;
      visited.add(parent.id);
      path.unshift(parent);
      m = parent;
    }
    return path;
  }

  const lastOpening = new Map(), answered = new Set();
  let selected;
  for (const m of incoming) {
    const recipients = addressees(m.text, names), path = ancestry(m);
    if (!path || recipients.some(name => name !== account)) continue;
    const direct = recipients.includes(account) || path.some(parent => parent.author === account || addressees(parent.text, names).includes(account));
    const ask = invitesReply(m.text);
    const previous = lastOpening.get(m.author);
    const recent = previous && m.at - previous.m.at <= 60_000 ? previous : null;
    const ownReply = !m.replyParentId && recentOwnReply(m);
    // The first answer to a confirmed question addressed to this viewer may be
    // a name, description, or number in any language.
    const answersOwnQuestion = ownReply && !answered.has(ownReply) && invitesReply(ownReply.text);
    if (answersOwnQuestion) answered.add(ownReply);
    const follows = continuesTurn(m.text, ownReply || recent?.direct) || ask;
    const refersBack = answersOwnQuestion || follows && (ownReply || recent || path.some(parent => invitesReply(parent.text)));
    if (!direct && !ask && !refersBack) continue;
    const priority = direct || refersBack && (ownReply || recent?.direct) ? 1 : 0;
    if (direct || ask) lastOpening.set(m.author, { m, path, direct: priority === 1 });
    if (m.at < time - targetAge) continue;
    if (!selected || priority >= selected.priority) {
      // Keep the verified parent when a later unthreaded line clarifies the viewer's question.
      const branch = !path.length && !direct && refersBack && recent?.path.length ? [...recent.path, recent.m] : path;
      selected = { m, path: branch, priority, ownReply };
    }
  }
  if (!selected) throw Object.assign(failure('There is no recent viewer question, request, or direct conversation to reply to in this channel.'), { code: 'no_conversation' });
  const { m: target, path, ownReply } = selected;
  const earlier = incoming.slice(0, incoming.indexOf(target)).filter(m => m.at >= target.at - targetAge
    && m.author === target.author && !m.replyParentId && addressees(m.text, names).every(name => name === account)).slice(-4);
  const contextRows = [...earlier, ...path];
  if (ownReply) contextRows.push(ownReply);
  const messages = [...new Set(contextRows)].sort((a, b) => a.at - b.at).map(m => ({ author: m.author, text: m.text }));
  const stream = instance.streamContext;
  const thread = new Set([target.id, target.replyParentId, ...path.map(m => m.id)].filter(messageId));
  return { target, thread, directed: selected.priority === 1, context: { account, channel, target: { author: target.author, text: target.text }, messages,
    stream: stream?.isLive && stream.channel === channel && fresh(stream.checkedAt, time, 120_000)
      ? { title: safeText(stream.title) ? stream.title : '', category: safeText(stream.gameName) ? stream.gameName : '' } : null } };
}

function hasNewerFollowUp(job, instance, names, time) {
  const messages = instance.chat.messages;
  const originalIndex = messages.findIndex(m => m.id === job.targetId && m.channel === job.channel && m.author === job.targetAuthor);
  return messages.some((m, index) => {
    if (m.author !== job.targetAuthor || m.channel !== job.channel || m.id === job.targetId || !messageId(m.id)
      || m.at < job.targetAt || m.at === job.targetAt && index <= originalIndex || m.at > time
      || m.isBot || m.bot || !safeText(m.text) || personalInsult(m.text)) return false;
    const recipients = addressees(m.text, names);
    if (recipients.some(name => name !== job.account)) return false;
    const follows = invitesReply(m.text) || continuesTurn(m.text, job.directed);
    if (m.replyParentId) return job.thread.has(m.replyParentId) && (job.directed || follows);
    if (recipients.includes(job.account) || m.at - job.targetAt <= 60_000 && follows) return true;
    return instance.sent.some(s => s.delivery === 'confirmed' && s.account === job.account && s.channel === job.channel
      && s.replyTo === job.targetAuthor && s.at > job.targetAt && s.at <= m.at && m.at - s.at <= 90_000 && safeText(s.text) && invitesReply(s.text));
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
    if (!['running', 'completed'].includes(job.command.state) || job.command.result?.suggested === false) return;
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
    } else {
      const names = roomNames(instance, companions);
      // A previously unseen plain name may become identifiable while the draft is open.
      const foreign = instance.chat.messages.some(m => m.channel === channel && m.author === targetAuthor && job.thread.has(m.id)
        && addressees(m.text, names).some(name => name !== account));
      if (foreign) {
        finish(job, 'cancelled', 'The viewer addressed another person. Request a fresh draft.');
      } else if (hasNewerFollowUp(job, instance, names, now())) {
        finish(job, 'cancelled', 'A newer message from @' + targetAuthor + ' changed the conversation. Request a fresh draft.');
      }
    }
  }

  function companionsFor(instances) {
    if (instances.some(i => !login(i.account)) && configured.size < instances.length) return null;
    return new Set([...configured, ...instances.map(i => i.account).filter(login)]);
  }

  async function generateDraft(job, context) {
    try {
      const raw = await generate(context, { signal: job.controller.signal, selectedConversation: true });
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
      finish(job, 'completed', '', { text, reason: 'Draft reply to @' + job.targetAuthor + '.', account: job.account, channel: job.channel, targetAuthor: job.targetAuthor,
        target: { id: job.targetId, author: job.targetAuthor, text: job.targetText, at: job.targetAt }, ...(job.streamId ? { streamId: job.streamId } : {}) });
    } catch (error) {
      if (job.command.state !== 'running') return;
      if (error?.code === 'no_reply') {
        finish(job, 'completed', '', { suggested: false, reason: 'No reply suggested. The conversation does not call for a response.' });
      } else {
        finish(job, 'failed', Object.hasOwn(modelErrors, error?.code)
          ? modelErrors[error.code] : 'The draft could not be generated. Refresh the account and check the on-device model.');
      }
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
    const { target, thread, directed, context } = selectConversation(instance, companions, now());
    const createdAt = now(), command = { id: 'review:' + body.requestId, ...body, state: 'running', createdAt, expiresAt: createdAt + jobTimeout, error: '' };
    const job = { id, command, thread, directed, account: instance.account, channel: instance.channel, streamId: streamId(instance),
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

  // A request can be repeated by a browser after losing the HTTP response.
  // Keep the result with the bounded draft receipt, including uncertain outcomes.
  function claimSend(instance, peers, reviewId, body) {
    const job = history(instance.id).find(j => j.command.requestId === reviewId);
    if (!job) return null;
    if (job.submission) {
      if (job.submission.requestId === body.requestId && job.submission.text === body.params.text) return job.submission;
      throw Object.assign(failure('This draft already has a send request. Check its delivery status before requesting another draft.'), { code: 'review_used' });
    }
    reconcile(job, instance, companionsFor(peers));
    if (job.command.state !== 'completed' || !job.command.result?.text || !job.command.result.targetAuthor) return null;
    job.submission = { requestId: body.requestId, text: body.params.text, outcome: null };
    finish(job, 'cancelled', 'This draft has been used. Check the separate send request for delivery status.');
    return job.submission;
  }

  function stop() {
    closed = true;
    for (const id of profiles) invalidate(id);
  }
  return { request, decorate, invalidate, claimSend, stop };
}
