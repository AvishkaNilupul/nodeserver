// Fetch the HLS master playlist for a channel. Doing this once (and touching
// the low-quality variant periodically) is what convinces Twitch's edge that
// a real player has the stream open. Spade pings alone are unreliable; a
// bot that never reads the playlist gets dropped from watch-time crediting
// after ~10 minutes.

import { getPlaybackAccessToken } from "./twitch.js";

export async function fetchMasterPlaylist(session, login) {
  const res = await getPlaybackAccessToken(session, login);
  const tok = res?.data?.streamPlaybackAccessToken;
  if (!tok?.value || !tok?.signature) {
    throw new Error("playback token unavailable: " + JSON.stringify(res).slice(0, 200));
  }
  const params = new URLSearchParams({
    client_id: session.clientId,
    token: tok.value,
    sig: tok.signature,
    allow_source: "true",
    allow_audio_only: "true",
    fast_bread: "true",
    p: String(Math.floor(Math.random() * 9_999_999)),
    player_backend: "mediaplayer",
    playlist_include_framerate: "true",
    reassignments_supported: "true",
    supported_codecs: "avc1",
    transcode_mode: "cbr_v1",
  });
  const url = `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${params}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": session.userAgent,
      Origin: "https://www.twitch.tv",
      Referer: "https://www.twitch.tv/",
    },
  });
  if (!r.ok) throw new Error("usher master playlist " + r.status);
  const text = await r.text();
  const variants = parseMaster(text);
  return { masterText: text, variants };
}

// Very small M3U8 master-playlist parser — just enough to pick the lowest
// bitrate variant so we can ping the smallest thing on offer.
function parseMaster(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = {};
    line
      .slice("#EXT-X-STREAM-INF:".length)
      .match(/([A-Z0-9\-]+)=("[^"]*"|[^,]+)/g)
      ?.forEach((kv) => {
        const [k, ...rest] = kv.split("=");
        attrs[k] = rest.join("=").replace(/^"|"$/g, "");
      });
    const url = (lines[i + 1] || "").trim();
    if (url && !url.startsWith("#")) {
      out.push({
        bandwidth: Number(attrs.BANDWIDTH || 0),
        resolution: attrs.RESOLUTION || "",
        codecs: attrs.CODECS || "",
        url,
      });
    }
  }
  return out.sort((a, b) => a.bandwidth - b.bandwidth);
}

export async function pingVariant(session, variantUrl) {
  const r = await fetch(variantUrl, {
    headers: {
      "User-Agent": session.userAgent,
      Origin: "https://www.twitch.tv",
      Referer: "https://www.twitch.tv/",
    },
  });
  return { ok: r.ok, status: r.status };
}
