import test from 'node:test';
import assert from 'node:assert/strict';
import { activitySummary, playbackSummary } from '../extension/activity.js';

const now = 1_000_000;
const connected = () => ({ settings: { account: 'companion_test', allowedChannel: 'friend_channel', autoReply: true }, chat: { connected: true, account: 'companion_test', channel: 'friend_channel' }, sent: [] });

test('a host hold is distinct from a healthy Twitch connection and a local companion pause', () => {
  const state = connected(); state.chat.coordination = { available: false, reason: 'Central host unavailable.' };
  assert.equal(activitySummary(state, now).chat.label, 'Connected to @friend_channel');
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for central host');
  state.chat.coordination = { available: true, paused: true, reason: 'Central coordination paused.' };
  assert.equal(activitySummary(state, now).replies.label, 'Central host paused');
  state.settings.paused = true;
  assert.equal(activitySummary(state, now).replies.label, 'Automatic chat paused');
});

test('old or undated playback observations cannot be displayed as playing', () => {
  assert.equal(playbackSummary({ enabled: true, status: 'playing', checkedAt: now - 45_001 }, now).label, 'Check overdue');
  assert.equal(playbackSummary({ enabled: true, status: 'playing' }, now).label, 'Checking player');
  assert.equal(playbackSummary({ enabled: true, status: 'playing', checkedAt: now - 1000, channel: 'friend_channel' }, now).label, 'Playing');
  assert.equal(playbackSummary({ enabled: true, status: 'ad', checkedAt: now }, now).label, 'Ad playing');
  assert.equal(playbackSummary({ enabled: false, status: 'paused' }, now).label, 'Checks off');
});

test('latest confirmed reply remains distinct from a more recent rejected or uncertain attempt', () => {
  const state = connected();
  state.sent = [{ at: now - 200_000, text: 'hello', channel: 'friend_channel', delivery: 'confirmed' }, { at: now - 1000, text: 'later', channel: 'friend_channel', delivery: 'unknown' }];
  const view = activitySummary(state, now);
  assert.equal(view.latestConfirmed.text, 'hello');
  assert.equal(view.latestAttempt.delivery, 'unknown');
  assert.equal(view.replies.label, 'Cooldown');
  assert.match(view.replies.detail, /2:59/);
  assert.equal(activitySummary({ ...state, sent: [state.sent[1]] }, now).latestConfirmed, null);
});

test('quiet status distinguishes waiting, generation, no matching response, cooldown and hourly budget', () => {
  const state = connected();
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for a direct mention');
  for (const [status, label] of [['generating', 'Preparing a reply'], ['no_match', 'Staying quiet'], ['error', 'Reply needs attention']]) {
    assert.equal(activitySummary({ ...state, activity: { state: status, reason: 'A useful reason', at: now } }, now).replies.label, label);
  }
  assert.equal(activitySummary({ ...state, activity: { state: 'generating', at: now - 91_000 } }, now).replies.label, 'Waiting for a direct mention');
  assert.equal(activitySummary({ ...state, sent: Array.from({ length: 6 }, (_, i) => ({ at: now - 200_000 - i, delivery: 'rejected' })) }, now).replies.label, 'Hourly limit reached');
});

test('channel mismatch and blocked alignment are visible without suggesting playback is stopped', () => {
  const state = { ...connected(), watch: { enabled: true, channel: 'new_channel', status: 'playing', checkedAt: now } };
  const view = activitySummary(state, now);
  assert.equal(view.playback.label, 'Playing');
  assert.equal(view.chat.label, 'Changing chat channel');
  assert.equal(view.replies.label, 'Waiting for chat');
  state.watch.syncStatus = 'blocked'; state.watch.syncError = 'The new chat is followers-only.';
  assert.equal(activitySummary(state, now).chat.detail, state.watch.syncError);
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for channel switch');
  state.settings.autoReply = false;
  assert.equal(activitySummary(state, now).replies.label, 'Automatic chat off');
  state.settings.paused = true;
  assert.equal(activitySummary(state, now).replies.label, 'Automatic chat paused');
});

test('a connected wrong account or channel is never shown as ready to reply', () => {
  const state = connected();
  state.chat.account = 'other_account';
  assert.equal(activitySummary(state, now).chat.label, 'Chat setup does not match');
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for chat');
  state.chat.account = state.settings.account; state.chat.channel = 'other_channel';
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for chat');
});

test('playback gates and fresh waiting reasons stay visible instead of a generic mention prompt', () => {
  const state = { ...connected(), watch: { enabled: true, channel: 'friend_channel', status: 'paused', checkedAt: now }, activity: { state: 'waiting', reason: 'Waiting for playback: paused.', at: now } };
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for playback');
  assert.match(activitySummary(state, now).replies.detail, /Video paused/);
  state.watch.status = 'playing'; state.watch.checkedAt = now - 60_000;
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for playback');
  state.watch.enabled = false;
  state.activity = { state: 'waiting', reason: 'Waiting for the channel to be verified.', at: now };
  assert.equal(activitySummary(state, now).replies.detail, state.activity.reason);
  state.activity = { state: 'generating', reason: 'Old task', at: now - 100_000 };
  state.sent = [{ at: now - 30_000, delivery: 'confirmed', text: 'hello' }];
  assert.equal(activitySummary(state, now).replies.label, 'Cooldown');
});

test('participation mode requires playback and explains conversation rather than mention-only behavior', () => {
  const state = connected(); state.settings.chatMode = 'participate';
  assert.equal(activitySummary(state, now).replies.label, 'Waiting for playback');
  state.watch = { enabled: true, channel: 'friend_channel', status: 'playing', checkedAt: now };
  const ready = activitySummary(state, now);
  assert.equal(ready.replies.label, 'Joining the conversation');
  assert.match(ready.replies.detail, /10 minutes/);
  state.activity = { state: 'generating', reason: 'Preparing the first greeting for this broadcast.', at: now };
  assert.equal(activitySummary(state, now).replies.label, 'Preparing a message');
  assert.equal(activitySummary(state, now).replies.detail, state.activity.reason);
  state.activity = { state: 'waiting', reason: 'The greeting and question were already attempted. Waiting for fresh chat.', at: now };
  assert.equal(activitySummary(state, now).replies.label, 'Waiting to join in');
  assert.equal(activitySummary(state, now).replies.detail, state.activity.reason);
  state.sent = [{ at: now - 30_000, delivery: 'unknown', text: 'hello' }];
  const cooldown = activitySummary(state, now).replies;
  assert.equal(cooldown.label, 'Cooldown');
  assert.match(cooldown.detail, /10 minutes/);
  assert.doesNotMatch(cooldown.detail, /Waiting for a fresh direct mention/);
});
