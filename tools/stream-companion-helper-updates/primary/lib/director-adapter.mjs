import { composeRequest, generate } from './composer.mjs';
import { directorBinding, sameBinding } from '../extension/director.js';
import { exchangeContext } from '../extension/chat-context.js';

const opaque = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);
/** Paired local execution adapter. Incoming chat/metadata never come from browser echoes. */
export class DirectorAdapter {
  constructor({ twitch, control, config, generateImpl = generate, now = Date.now } = {}) {
    Object.assign(this, { twitch, control, config, generateImpl, now });
    this.calls = []; this.generations = new Map(); this.busy = false;
  }
  binding(input, { allowStopped = false, action } = {}) {
    this.control.guard(input, { allowStopped, requireSession: true, action });
    const binding = directorBinding(input, input.settingsRevision);
    const settings = this.control.browserState?.settings;
    if (!settings || settings.revision !== binding.settingsRevision) throw Error('Browser settings changed; central message execution is held.');
    return binding;
  }
  async import(input) {
    this.binding(input, { allowStopped: true });
    if (input.page?.source !== 'browser') throw Error('Only this paired browser may import its own journals.');
    await this.twitch.coordinator.ensureHelperImport();
    return this.twitch.coordinator.importPage(input.page);
  }
  async observation(input) {
    const binding = this.binding(input, { allowStopped: true });
    const settings = this.control.browserState.settings, watch = this.control.browserState.watch || {};
    const channel = this.twitch.channel || '';
    let info = null;
    if (channel && this.twitch.connected) info = await this.twitch.inspectChannel(this.twitch.credentials.account, channel);
    this.binding(input, { allowStopped: true });
    const sendHeld = this.twitch.sendHold().held;
    const armed = !this.control.stopped && !settings.paused && settings.autoReply === true && !sendHeld;
    const context = info?.streamContext || null;
    await this.twitch.refreshCoordination({ channel, paused: this.control.stopped || settings.paused,
      autoReply: armed, chatMode: settings.chatMode, playback: { enabled: watch.enabled === true,
        channel: watch.channel || '', status: watch.status || 'unknown', checkedAt: watch.checkedAt || 0 },
      exchangeContext: armed && settings.chatMode === 'participate' ? exchangeContext({ messages: this.twitch.messages,
        account: this.twitch.credentials.account, channel, streamContext: context,
        accounts: this.twitch.coordinator.snapshot(channel).accounts || [], now: this.now() }) : null });
    this.binding(input, { allowStopped: true });
    return { protocol: 1, binding, armed, streamContext: context,
      messages: this.twitch.status().messages.slice(-60),
      restrictions: { sharedChat: info?.sharedChat === true, emoteOnly: info?.chatSettings?.emoteOnly === true,
        subscribersOnly: info?.chatSettings?.subscribersOnly === true, sendHeld } };
  }
  async sync(input, { resolve = true } = {}) {
    const observation = await this.observation(input);
    const result = await this.twitch.coordinator.directorRequest('observe', observation);
    return resolve ? this.resolveGeneration(result, input) : result;
  }
  async draft(input) {
    const binding = this.binding(input, { action: 'draft' });
    const hold = this.twitch.sendHold(); if (hold.held) throw Error(hold.reason);
    if (!opaque(input.requestId) || !['reply', 'summary', 'phrase'].includes(input.mode)
      || input.mode === 'phrase' && typeof input.category !== 'string') throw Error('Invalid central draft request.');
    await this.sync(input, { resolve: false });
    this.binding(input, { action: 'draft' });
    const result = await this.twitch.coordinator.directorRequest('draft', { requestId: input.requestId, binding,
      mode: input.mode, ...(input.mode === 'phrase' ? { category: input.category } : {}) });
    return this.resolveGeneration(result, input);
  }
  async manual(input) {
    const binding = this.binding(input, { action: 'send' });
    const hold = this.twitch.sendHold(); if (hold.held) throw Error(hold.reason);
    if (!opaque(input.requestId) || typeof input.text !== 'string') throw Error('Invalid central reviewed message.');
    await this.sync(input, { resolve: false });
    this.binding(input, { action: 'send' });
    return this.twitch.coordinator.directorRequest('manual', { requestId: input.requestId, binding, text: input.text });
  }
  async preferences(input) {
    this.binding(input, { allowStopped: true, action: 'settings' });
    if (!opaque(input.requestId) || !['mentions', 'participate'].includes(input.chatMode)
      || !['local', 'ai'].includes(input.replySource)) throw Error('Invalid central message preferences.');
    return this.twitch.coordinator.request('/internal/director/preferences', { requestId: input.requestId,
      chatMode: input.chatMode, replySource: input.replySource });
  }
  guardSend(input) {
    const binding = this.binding(input, { action: 'send' });
    if (!sameBinding(input.binding, binding)) throw Error('The central message belongs to older browser settings.');
    const plan = this.twitch.coordinator.currentPlan(input.planId, binding);
    if (!plan || plan.authorityEpoch !== input.authorityEpoch || plan.text !== input.text) throw Error('An exact current central message command is required.');
    if (plan.source === 'automatic') {
      const settings = this.control.browserState.settings, watch = this.control.browserState.watch || {};
      if (!settings.autoReply || settings.paused || !watch.enabled || watch.channel !== plan.channel
        || !['playing', 'ad'].includes(watch.status) || watch.checkedAt > this.now() + 5000 || this.now() - watch.checkedAt > 45_000
        || plan.kind && settings.chatMode !== 'participate') throw Error('Automatic central messages are held until current playback and participation are armed.');
    }
    return plan;
  }
  async resolveGeneration(result, input) {
    const work = result?.generation || result?.director?.generation;
    if (!work) return result;
    const binding = this.binding(input);
    if (!opaque(work.generationId) || !opaque(work.requestId) || !sameBinding(work.binding, binding)
      || work.account !== this.twitch.credentials.account || work.channel !== this.twitch.channel
      || !['reply', 'summary'].includes(work.mode)) throw Error('Invalid central model request.');
    let pending = this.generations.get(work.generationId);
    if (!pending) {
      if (this.generations.size >= 32) this.generations.delete(this.generations.keys().next().value);
      pending = (async () => {
        this.calls = this.calls.filter(at => at > this.now() - 3_600_000);
        if (this.busy || this.calls.length >= 30 || !this.config.apiKey) return { text: '', reason: 'The central model adapter is unavailable; staying quiet.' };
        const hold = this.twitch.sendHold();
        if (hold.held) return { text: '', reason: hold.reason };
        let target;
        if (work.target) {
          target = this.twitch.messages.find(message => message.id === work.target.id && message.author === work.target.author
            && message.text === work.target.text && message.at === work.target.at && message.at <= this.now() && this.now() - message.at <= 45_000);
          if (!target) return { text: '', reason: 'The central reply target is no longer current.' };
        }
        const info = await this.twitch.inspectChannel(work.account, work.channel);
        this.binding(input);
        const request = composeRequest({ mode: work.mode, channel: work.channel, account: work.account,
          messages: this.twitch.status().messages, target, streamContext: info.streamContext, recentReplies: this.twitch.history });
        this.busy = true; this.calls.push(this.now());
        try { return await this.generateImpl(request, this.config); }
        catch (error) { return { text: '', reason: this.control.diagnostic(error.message) }; }
        finally { this.busy = false; }
      })();
      this.generations.set(work.generationId, pending);
    }
    const generated = await pending;
    this.binding(input);
    return this.twitch.coordinator.directorRequest('generated', { requestId: work.requestId,
      generationId: work.generationId, binding, result: { text: generated.text || '',
        ...(generated.summary ? { summary: generated.summary } : {}), reason: generated.reason || '' } });
  }
}
