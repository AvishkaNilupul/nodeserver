// Only recover a receive subscription that was actually connected for this
// browser session. A heartbeat can never Start a stopped or unconfigured account.
export class ChatRecovery {
  constructor({ control, twitch, locked, now, routeReady = () => true }) {
    this.control = control;
    this.twitch = twitch;
    this.locked = locked;
    this.now = now;
    this.routeReady = routeReady;
    this.reset();
  }

  reset() {
    this.target = null;
    this.attempts = 0;
    this.flight = null;
    this.report = { state: 'idle', lastAttemptAt: 0, nextAttemptAt: 0, reason: '' };
  }

  status() {
    if (this.control.stopped) return { ...this.report, state: 'held', nextAttemptAt: 0, reason: 'Companion stopped.' };
    if (this.target && !this.control.online()) return { ...this.report, state: 'held', nextAttemptAt: 0, reason: 'Waiting for the paired browser.' };
    return { ...this.report };
  }

  setState(state, reason, nextAttemptAt = 0) {
    Object.assign(this.report, { state, reason, nextAttemptAt });
  }

  // Also handles the older extension's alarm for a subscription owned here.
  // Explicit Start and navigation use their original connect/disarm protocol.
  owns(input) {
    const target = this.target;
    return !!target && input.explicitStart !== true && input.controlCommandId === undefined
      && target.sessionId === input.controlSessionId && target.generation === input.controlGeneration
      && target.channel === input.channel && target.account === input.account;
  }

  heartbeat(input) {
    try { this.observe(input); }
    catch {
      // LocalControl may already have claimed a command for this heartbeat.
      // A broken diagnostic must never lose that response.
      this.setState('waiting', 'Chat connection status unavailable. Checking again on the next browser heartbeat.', this.report.nextAttemptAt);
    }
  }

  observe(input) {
    const { control } = this;
    if (!input.state || input.sessionId !== control.sessionId || input.controlGeneration !== control.generation) return;
    const settings = control.browserState.settings, watch = control.browserState.watch;
    if (control.stopped || !settings || settings.paused || !(settings.autoResume || settings.autoReply)
      || !settings.allowedChannel || watch?.enabled && watch.channel !== settings.allowedChannel) {
      this.reset();
      return;
    }
    const raw = this.twitch.status();
    if (!raw.account || input.state.account !== raw.account) { this.reset(); return; }
    let target = this.target;
    if (target && (target.generation !== control.generation || target.sessionId !== input.sessionId
      || target.account !== raw.account || target.channel !== settings.allowedChannel || target.revision !== settings.revision)) {
      this.reset(); target = null;
    }
    if (raw.connected && raw.channel === settings.allowedChannel) {
      if (!target) this.target = { generation: control.generation, sessionId: input.sessionId, account: raw.account, channel: raw.channel, revision: settings.revision };
      if (this.attempts) this.setState('recovered', 'Twitch confirmed the chat subscription.');
      this.attempts = 0;
      return;
    }
    if (!target) return;
    if (raw.authorized !== true || raw.recoverable === false) {
      this.setState('held', 'Twitch authorization or the subscription requires attention. Start chat after resolving it.');
      return;
    }
    if (raw.channel && raw.channel !== target.channel) { this.reset(); return; }
    if (this.flight || raw.channel) return; // A socket is awaiting its welcome/subscription acknowledgement.
    if (!this.routeReady()) {
      this.setState('held', 'Waiting for a fresh US route from the paired browser.', this.report.nextAttemptAt);
      return;
    }
    if (this.report.nextAttemptAt > this.now()) {
      this.setState('waiting', 'The last attempt did not restore chat. Waiting to retry.', this.report.nextAttemptAt);
      return;
    }
    const check = () => {
      try {
        if (target !== this.target || target.revision !== control.browserState.settings?.revision) throw new Error('Chat setup changed.');
        control.guard({ controlGeneration: target.generation, controlSessionId: target.sessionId }, { requireSession: true });
      } catch (error) {
        // TwitchChat classifies failures from beforeConnect along with provider
        // errors. An expired local lease must never revoke the Twitch subscription.
        throw Object.assign(error, { retryable: true });
      }
    };
    const run = async () => {
      check();
      const current = this.twitch.status();
      if (current.connected || current.channel || current.account !== target.account || !current.authorized || current.recoverable === false || !this.routeReady()) return;
      this.report.lastAttemptAt = this.now();
      this.attempts = Math.min(this.attempts + 1, 5);
      const next = () => this.report.lastAttemptAt + Math.min(60_000, 5000 * 2 ** (this.attempts - 1));
      this.setState('retrying', 'Reconnecting to Twitch chat.');
      try {
        await this.twitch.connect(target.account, target.channel, { beforeConnect: check, recoverHistory: true });
        check();
        this.setState('retrying', 'Waiting for Twitch to confirm the chat subscription.', next());
      } catch {
        if (target === this.target) this.setState('waiting', 'The chat connection attempt failed.', next());
      }
    };
    const flight = this.locked(run);
    this.flight = flight;
    void flight.catch(() => {}).finally(() => { if (this.flight === flight) this.flight = null; });
  }
}
