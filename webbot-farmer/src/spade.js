// Minute-watched analytics ping. Twitch's back-end credits stream watch-time
// (which advances drop counters) based on these pings — not on whether the
// bot actually downloaded any video frames.

import { randomUUID } from "node:crypto";

const SPADE_URL = "https://spade.twitch.tv/track";

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

// Fresh play_session_id per attach. Real players generate one when the
// player opens and keep it for the life of that view.
export function makePlaySessionId() {
  return randomUUID().replace(/-/g, "");
}

// Build ONE minute-watched event for the given channel/stream. Field set
// mirrors what a real twitch.tv web player POSTs — omitting any of these
// means Twitch's ingest may silently drop the event for drop-crediting.
export function buildMinuteWatchedEvent({ session, channelId, channelLogin, broadcastId, gameId, gameName, playSessionId }) {
  const payload = [
    {
      event: "minute-watched",
      properties: {
        channel_id: Number(channelId),
        channel: channelLogin,
        broadcast_id: broadcastId ? Number(broadcastId) : 0,
        player: "site",
        user_id: Number(session.userId),
        live: true,
        logged_in: true,
        hidden: false,
        muted: false,
        volume: 0.5,
        subscribed: false,
        backend: "mediaplayer",
        player_state: "Playing",
        distinct_id: session.deviceId,
        device_id: session.deviceId,
        play_session_id: playSessionId,
        url: `https://www.twitch.tv/${channelLogin}`,
        referrer_url: "",
        domain: "www.twitch.tv",
        app_version: "web",
        game: gameName || "",
        game_id: gameId ? Number(gameId) : undefined,
        platform: "web",
        player_type: "site",
        received_language: "en",
        received_bitrate: 3500000,
        received_frames: 3600,
        video_dropped_frames: 0,
        buffer_empty_count: 0,
        buffer_size: 0,
        client_time: Date.now() / 1000,
      },
    },
  ];
  return payload;
}

export async function sendMinuteWatched({ session, channelId, channelLogin, broadcastId, gameId, gameName, playSessionId }) {
  const evt = buildMinuteWatchedEvent({
    session,
    channelId,
    channelLogin,
    broadcastId,
    gameId,
    gameName,
    playSessionId,
  });
  const body = "data=" + encodeURIComponent(b64(JSON.stringify(evt)));
  const r = await fetch(SPADE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": session.userAgent,
      Origin: "https://www.twitch.tv",
      Referer: `https://www.twitch.tv/${channelLogin}`,
    },
    body,
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: text };
}
