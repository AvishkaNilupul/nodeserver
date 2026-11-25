const stamp = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;

export function playbackSummary(watch = {}, now = Date.now()) {
  if (!watch.enabled) return { label: 'Checks off', detail: 'Use Watch on Twitch to check one stream tab.', tone: 'muted' };
  const checkedAt = stamp(watch.checkedAt || watch.lastCheck || watch.at);
  const channel = watch.channel ? `@${watch.channel}` : 'The stream tab';
  if (checkedAt && now - checkedAt > 45_000) return { label: 'Check overdue', detail: `${channel} has not reported recently. Playback is unverified.`, tone: 'warning' };
  const states = {
    playing: ['Playing', `${channel} · video is advancing.`, 'good'],
    ad: ['Ad playing', `${channel} · normal Twitch ad break.`, 'good'],
    advertisement: ['Ad playing', `${channel} · normal Twitch ad break.`, 'good'],
    paused: ['Video paused', 'Use Twitch’s player to resume.', 'warning'],
    buffering: ['Buffering', 'Waiting for the player to advance.', 'warning'],
    stalled: ['Playback stalled', 'The video has stopped advancing. Check the stream tab.', 'warning'],
    ended: ['Stream ended', 'The player has finished.', 'warning'],
    offline: ['Channel offline', `${channel} is not showing a live broadcast.`, 'warning'],
    loading: ['Checking player', `Waiting for ${channel} to load.`, 'muted'],
    checking: ['Checking player', 'Waiting for a fresh playback observation.', 'muted'],
    missing: ['Player not found', 'Check that the stream page has loaded.', 'warning'],
    unavailable: ['Playback unavailable', 'The stream page could not be checked.', 'warning'],
    navigating: ['Changing channel', 'Waiting for the new stream page.', 'muted'],
    stale: ['Check overdue', 'Playback has not been verified recently.', 'warning'],
    error: ['Player needs attention', watch.error || 'Check the stream tab.', 'warning']
  };
  // A state without a timestamp is an unverified observation, never a healthy player.
  if (!checkedAt && ['playing', 'ad', 'advertisement'].includes(watch.status)) return { label: 'Checking player', detail: 'Waiting for a fresh playback observation.', tone: 'muted' };
  const [label, detail, tone] = states[watch.status] || ['Playback unverified', watch.error || 'Waiting for a player observation.', 'muted'];
  return { label, detail, tone };
}

export function activitySummary(state = {}, now = Date.now()) {
  const { settings: s = {}, chat: c = {}, sent = [], watch = {}, activity = {}, helperError = '' } = state;
  const participating = s.chatMode === 'participate';
  const recent = sent.filter(x => Number.isFinite(x.at) && x.at <= now && x.at > now - 3_600_000);
  const ordered = [...sent].filter(x => Number.isFinite(x.at)).sort((a, b) => b.at - a.at);
  const latestConfirmed = ordered.find(x => x.delivery === 'confirmed') || null;
  const latestAttempt = ordered[0] || null;
  const freshActivity = stamp(activity.at) <= now && now - stamp(activity.at) < 90_000 && (!activity.channel || activity.channel === s.allowedChannel);
  const playback = playbackSummary(watch, now);
  const playbackBlocked = participating && !watch.enabled || watch.enabled && !['Playing', 'Ad playing'].includes(playback.label);
  let chat = c.connected ? { label: `Connected to @${c.channel}`, detail: `Receiving chat as @${c.account}.`, tone: 'good' }
    : { label: s.paused ? 'Chat paused' : 'Chat disconnected', detail: s.paused ? 'Resume when you want to join chat again.' : 'Connect chat to receive messages.', tone: 'muted' };
  if (helperError || c.error) chat = { label: 'Chat needs attention', detail: helperError || c.error, tone: 'warning' };
  const mismatch = watch.enabled && watch.channel && c.connected && watch.channel !== c.channel;
  const wrongIdentity = c.connected && (c.channel !== s.allowedChannel || c.account?.toLowerCase() !== s.account?.toLowerCase());
  if (wrongIdentity) chat = { label: 'Chat setup does not match', detail: 'Connect the configured account and channel before replying.', tone: 'warning' };
  if (mismatch) chat = { label: 'Changing chat channel', detail: `Video is on @${watch.channel}; chat is still on @${c.channel}.`, tone: 'warning' };
  if (watch.enabled && ['blocked', 'error'].includes(watch.syncStatus)) chat = { label: 'Channel switch needs attention', detail: watch.syncError || 'The new channel could not be joined automatically.', tone: 'warning' };
  let replies;
  if (s.paused) replies = { label: 'Automatic chat paused', detail: 'No automatic messages while the companion is paused.', tone: 'muted' };
  else if (freshActivity && activity.state === 'switching') replies = { label: 'Waiting for channel switch', detail: activity.reason || 'Replies wait until video and chat match.', tone: 'warning' };
  else if (!s.autoReply) replies = { label: 'Automatic chat off', detail: 'You can still draft and send a message.', tone: 'muted' };
  else if (watch.enabled && ['blocked', 'error'].includes(watch.syncStatus)) replies = { label: 'Waiting for channel switch', detail: watch.syncError || 'The new channel could not be joined automatically.', tone: 'warning' };
  else if (!c.connected || helperError || c.error || mismatch || wrongIdentity) replies = { label: 'Waiting for chat', detail: 'Replies need the configured chat connection.', tone: 'warning' };
  else if (c.coordination?.available === false || c.coordination?.paused) replies = {
    label: c.coordination.paused ? 'Central host paused' : 'Waiting for central host',
    detail: c.coordination.reason || 'The central host is holding automatic chat.', tone: 'warning'
  };
  else if (recent.length >= 6) replies = { label: 'Hourly limit reached', detail: 'Six attempts in the last hour. Automatic chat resumes as that window clears.', tone: 'muted' };
  else if (recent.some(x => now - x.at < 180_000)) {
    const remaining = Math.ceil((Math.max(...recent.map(x => x.at)) + 180_000 - now) / 1000);
    replies = { label: 'Cooldown', detail: `Global cooldown ends in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}. ${participating ? 'Conversation participation also waits at least 10 minutes between attempts.' : 'Waiting for a fresh direct mention.'}`, tone: 'muted' };
  } else if (playbackBlocked) replies = { label: 'Waiting for playback', detail: participating && !watch.enabled ? 'Use Watch on Twitch. Joining the conversation needs the selected live stream to be playing.' : `${playback.label}. ${playback.detail}`, tone: 'warning' };
  else if (freshActivity && activity.state === 'generating') replies = { label: participating ? 'Preparing a message' : 'Preparing a reply', detail: activity.reason || (participating ? 'Joining the current conversation.' : 'Answering a fresh direct mention.'), tone: 'muted' };
  else if (freshActivity && activity.state === 'no_match') replies = { label: 'Staying quiet', detail: activity.reason || (participating ? 'No useful conversation opportunity right now.' : 'The latest mention did not have a suitable reply.'), tone: 'muted' };
  else if (freshActivity && activity.state === 'error') replies = { label: 'Reply needs attention', detail: activity.reason || 'The last reply could not be completed.', tone: 'warning' };
  else if (freshActivity && activity.state === 'waiting' && activity.reason) replies = {
    label: /direct mention/i.test(activity.reason) ? 'Waiting for a direct mention' : /playback/i.test(activity.reason) ? 'Waiting for playback' : participating ? 'Waiting to join in' : 'Waiting',
    detail: activity.reason, tone: /direct mention/i.test(activity.reason) ? 'good' : 'muted'
  };
  else replies = participating
    ? { label: 'Joining the conversation', detail: 'Automatic chat is on. One greeting, useful chat replies, and an occasional category question; participation attempts are at least 10 minutes apart.', tone: 'good' }
    : { label: 'Waiting for a direct mention', detail: 'Automatic chat is on. Other chat does not trigger a message.', tone: 'good' };
  return { playback, chat, replies, latestConfirmed, latestAttempt };
}
