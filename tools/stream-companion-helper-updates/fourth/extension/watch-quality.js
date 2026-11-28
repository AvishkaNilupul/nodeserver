// Serialized into the operator-selected watch document. Only the native
// Settings > Quality menu is used. Call once after playback starts.
export async function preferLowWatchQuality(expectedUrl, session) {
  let expected;
  try { expected = new URL(expectedUrl); } catch { return 0; }
  const channel = expected.pathname.replace(/^\/|\/$/g, '');
  const reserved = /^(directory|settings|downloads|videos|subscriptions|inventory|drops|wallet|search|popout|clip|clips|collections|dashboard|login|signup|logout|activate|turbo|jobs|p|friends|messages|store|products|prime|team|teams|bits|checkout|payments|moderator)$/i;
  const enteredHash = location.hash;
  const samePage = () => location.origin === 'https://www.twitch.tv' && expected.origin === location.origin
    && expected.pathname === location.pathname && expected.search === location.search && (expected.hash === location.hash || !expected.hash && location.hash === '#companion-watch') && enteredHash === location.hash;
  if (!samePage() || expected.username || expected.password || !/^[a-z0-9_]{3,25}$/i.test(channel) || reserved.test(channel)) return 0;

  const player = document.querySelector('[data-a-target="video-player"], [data-test-selector="video-player"]');
  const find = target => player?.querySelector(`[data-a-target="${target}"]`);
  const gear = find('player-settings-button');
  const menu = () => find('player-settings-menu');
  const previousFocus = document.activeElement;
  if (!gear || gear.matches(':disabled,[aria-disabled="true"],[aria-expanded="true"]') || menu() || previousFocus?.matches('input,textarea,[contenteditable="true"],[role="textbox"]')) return 0;

  const video = [...player.querySelectorAll('video')].find(v => v.videoHeight && !v.paused && !v.ended && !v.error && v.getClientRects().length
    && (!v.checkVisibility || v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })));
  const blocks = '[data-a-target="video-ad-label"],[data-a-target="video-ad-countdown"],[data-a-target="player-overlay-offline"],[data-a-target="player-overlay-error"],[data-test-selector="ad-banner-default-text"],[data-test-selector="ad-banner-countdown"],[data-test-selector="video-player-error"]';
  let interrupted = false, opened = false;
  const interrupt = event => { if (event.isTrusted) interrupted = true; };
  const canChange = () => !interrupted && samePage() && player.isConnected && video?.isConnected && !video.paused && !video.ended && !video.error
    && ![...player.querySelectorAll(blocks)].some(el => el.getClientRects().length);
  if (!canChange() || /commercial\s+break\s+in\s+progress/i.test(player.innerText ?? player.textContent ?? '')) return 0;
  const currentSession = async () => {
    if (!session) return true;
    return await chrome.runtime.sendMessage({
      type: 'watchQualityActive', sessionId: session.sessionId, generation: session.generation
    }) === true;
  };
  // React normally commits the menu in the click microtask. A bounded DOM
  // observer also covers asynchronous menu rendering without a polling loop.
  const waitFor = read => {
    if (read()) return Promise.resolve(read());
    return new Promise(resolve => {
      const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(read()); };
      const observer = new MutationObserver(() => { if (!canChange() || read()) finish(); });
      const timer = setTimeout(finish, 400);
      observer.observe(player, { childList: true, subtree: true, attributes: true });
    });
  };
  document.addEventListener('pointerdown', interrupt, true);
  document.addEventListener('keydown', interrupt, true);
  try {
    if (!await currentSession() || !canChange() || menu()) return 0;
    gear.click();
    opened = true;
    const quality = await waitFor(() => find('player-settings-menu-item-quality'));
    if (!quality || !await currentSession() || !canChange()) return 0;
    quality.click();
    const selector = '[data-a-target="player-settings-submenu-quality-option"]';
    if (!await waitFor(() => menu()?.querySelector(selector)) || !canChange()) return 0;
    const candidates = [];
    for (const node of menu().querySelectorAll(selector)) {
      const control = node.matches('input') ? node : node.querySelector('input') || node;
      const label = control.labels?.[0] || node.closest('label') || node;
      const text = (label.textContent || node.getAttribute('aria-label') || '').trim();
      const match = /^(\d{2,4})p(?:\s*(\d{2,3}))?(?!\d)/i.exec(text);
      if (!match || !label.getClientRects().length || control.matches(':disabled,[aria-disabled="true"]')
        || node.closest('[aria-disabled="true"],[hidden]')) continue;
      candidates.push({ control, height: Number(match[1]), fps: Number(match[2] || 30) });
    }
    candidates.sort((a, b) => a.height - b.height || a.fps - b.fps);
    const lowest = candidates[0];
    if (!lowest || lowest.height > video.videoHeight) return 0;
    const selected = lowest.control.checked || lowest.control.getAttribute('aria-checked') === 'true';
    if (selected) return lowest.height;
    // A source-only menu cannot save resources. Keep the player's current mode.
    if (candidates.at(-1).height === lowest.height && lowest.height >= video.videoHeight) return 0;
    if (!await currentSession() || !canChange() || !lowest.control.isConnected) return 0;
    lowest.control.click();
    await Promise.resolve();
    return lowest.height;
  } finally {
    document.removeEventListener('pointerdown', interrupt, true);
    document.removeEventListener('keydown', interrupt, true);
    if (opened && !interrupted && samePage() && gear.isConnected && menu()) gear.click();
    if (opened && !interrupted && samePage() && previousFocus?.isConnected && document.activeElement !== previousFocus
      && (player.contains(document.activeElement) || document.activeElement === document.body)) {
      if (previousFocus === document.body) document.activeElement?.blur();
      else previousFocus.focus({ preventScroll: true });
    }
  }
}
