// This function is serialized by chrome.scripting into the tracked tab's
// isolated world. It only reads the native page/player; it never controls it.
export function watchPage() {
  const result = { url: location.href, hasVideo: false, videoId: '', currentTime: 0, readyState: 0, paused: false, ended: false, ad: false, commercialBreak: false, offline: false, error: false };
  if (location.origin !== 'https://www.twitch.tv') return result;
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    // Opacity and ancestor visibility do not remove layout rectangles. Retired
    // ad/preview layers can otherwise mask the native video that is on screen.
    for (let node = el; node?.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
        || style.opacity !== '' && Number(style.opacity) === 0) return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const player = document.querySelector('[data-a-target="video-player"], [data-test-selector="video-player"]');
  // A side preview must not establish the main stream's playback. If Twitch
  // exposes its player wrapper, an audio-only/empty player stays unverified.
  const videos = [...(player || document).querySelectorAll('video')].filter(visible);
  videos.sort((a, b) => {
    const active = video => !video.paused && !video.ended && !video.error;
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return Number(active(b)) - Number(active(a)) || y.width * y.height - x.width * x.height;
  });
  const video = videos[0];
  const has = selector => [...document.querySelectorAll(selector)].some(visible);
  result.offline = has('[data-a-target="player-overlay-offline"], [data-a-target="video-player-offline"], [data-test-selector="offline-channel-main-content"]');
  // Limit fallback text checks to the player. Native chat can contain any of
  // these words and must never be mistaken for a playback condition.
  const playerText = (player?.innerText ?? player?.textContent ?? '').slice(0, 12000);
  // The slate describes an ad interval, not why Twitch selected that slate.
  // It can also be rendered inside video pixels, which this DOM-only reader
  // cannot inspect; in that case keep reporting only observable player state.
  result.commercialBreak = visible(player) && /commercial\s+break\s+in\s+progress/i.test(playerText);
  if (!video && /(?:is currently offline|this channel is offline|stream has ended)/i.test(playerText)) result.offline = true;
  result.ad = has('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"], [data-test-selector="ad-banner-countdown"]');
  result.error = has('[data-a-target="player-overlay-error"], [data-test-selector="video-player-error"]') || /(?:error\s*#\s*\d{3,5}|network error occurred|error occurred while decoding)/i.test(playerText);
  if (video) {
    // This cache belongs only to this extension's isolated world and document.
    // Weak keys retain no detached media and expose no media URL or page text.
    const key = Symbol.for('stream-companion.watch.media.v1');
    let media = globalThis[key];
    if (!media || media.document !== document) {
      media = { document, ids: new WeakMap(), next: 1 };
      Object.defineProperty(globalThis, key, { value: media, configurable: true });
    }
    if (!media.ids.has(video)) media.ids.set(video, `v${media.next++}`);
    result.videoId = media.ids.get(video);
    result.hasVideo = true;
    result.decodedHeight = video.videoHeight || 0;
    result.currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    result.readyState = video.readyState;
    result.paused = video.paused;
    result.ended = video.ended;
    result.error ||= !!video.error;
  }
  return result;
}
