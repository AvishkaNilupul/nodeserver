// A normal Twitch tab pays only this URL check. A tagged watch tab listens for
// native media progress until it has made its one quality choice.
export function attachWatchTab(preferLowWatchQuality) {
  const start = new URL(location.href);
  if (start.origin !== 'https://www.twitch.tv' || start.hash !== '#companion-watch' ||
      start.search || !/^\/[a-z0-9_]{3,25}\/?$/i.test(start.pathname)) return;
  const expected = start.origin + start.pathname;
  const playerSelector = '[data-a-target="video-player"], [data-test-selector="video-player"]';
  const adSelector = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"], [data-test-selector="ad-banner-default-text"], [data-test-selector="ad-banner-countdown"]';
  let lastVideo, lastTime = 0;
  const stop = () => {
    document.removeEventListener('timeupdate', progress, true);
    window.removeEventListener('pagehide', stop);
    window.removeEventListener('hashchange', checkLocation);
    window.removeEventListener('popstate', checkLocation);
  };
  const checkLocation = () => { if (location.href !== start.href) stop(); };
  async function progress(event) {
    if (location.href !== start.href) return stop();
    const video = event.target;
    if (video.tagName !== 'VIDEO' || video.paused || video.ended || video.readyState < 3) return;
    const player = video.closest(playerSelector);
    if (!player || !video.getClientRects().length) return;
    if (video !== lastVideo || video.currentTime < lastTime) {
      lastVideo = video; lastTime = video.currentTime; return;
    }
    if (video.currentTime - lastTime < 1) return;
    lastTime = video.currentTime;
    if ([...player.querySelectorAll(adSelector)].some(el => el.getClientRects().length)) return;
    stop();
    try {
      if (location.href === start.href && video.isConnected && !video.paused && !video.ended) {
        await preferLowWatchQuality(expected);
      }
    } catch {
      // An extension reload or player change leaves Twitch's current quality in place.
    }
  }
  document.addEventListener('timeupdate', progress, true);
  window.addEventListener('pagehide', stop, { once: true });
  window.addEventListener('hashchange', checkLocation);
  window.addEventListener('popstate', checkLocation);
}
