// This function is serialized by chrome.scripting into the tracked tab's
// isolated world. It only reads the native page/player; it never controls it.
export function watchPage() {
  const result = { url: location.href, hasVideo: false, currentTime: 0, readyState: 0, paused: false, ended: false, ad: false, offline: false, error: false };
  if (location.origin !== 'https://www.twitch.tv') return result;
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const player = document.querySelector('[data-a-target="video-player"], [data-test-selector="video-player"]');
  const videos = [...document.querySelectorAll('video')].filter(visible);
  videos.sort((a, b) => {
    const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
    return y.width * y.height - x.width * x.height;
  });
  const video = videos[0];
  const has = selector => [...document.querySelectorAll(selector)].some(visible);
  result.offline = has('[data-a-target="player-overlay-offline"], [data-a-target="video-player-offline"], [data-test-selector="offline-channel-main-content"]');
  // Limit fallback text checks to the player. Native chat can contain any of
  // these words and must never be mistaken for a playback condition.
  const playerText = (player?.textContent || '').slice(0, 12000);
  if (!video && /(?:is currently offline|this channel is offline|stream has ended)/i.test(playerText)) result.offline = true;
  result.ad = has('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"], [data-test-selector="ad-banner-countdown"]');
  result.error = has('[data-a-target="player-overlay-error"], [data-test-selector="video-player-error"]') || /(?:error\s*#\s*\d{3,5}|network error occurred|error occurred while decoding)/i.test(playerText);
  if (video) {
    result.hasVideo = true;
    result.currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    result.readyState = video.readyState;
    result.paused = video.paused;
    result.ended = video.ended;
    result.error ||= !!video.error;
  }
  return result;
}
