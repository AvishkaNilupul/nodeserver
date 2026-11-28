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

  const playerSelector = '[data-a-target="video-player"], [data-test-selector="video-player"]';
  const gearSelector = '[data-a-target="player-settings-button"]';
  const player = document.querySelector(playerSelector);
  const gear = player?.querySelector(gearSelector);
  const previousFocus = document.activeElement;
  const visible = el => el.getClientRects().length > 0 &&
    (!el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  // Twitch mounts this popover beside the page root. Capture the single new
  // settings menu created by this gear, then retain that exact node or shell.
  const menuSelector = '[data-a-target="player-settings-menu"], [role="menu"][aria-labelledby~="active-settings-menu-header"]';
  const menus = () => [...new Set([...document.querySelectorAll(menuSelector)].filter(visible)
    .map(el => el.closest('[role="menu"][aria-labelledby~="active-settings-menu-header"]') || el))];
  if (!gear || gear.matches(':disabled,[aria-disabled="true"],[aria-expanded="true"]') || menus().length
    || previousFocus?.matches('input,textarea,[contenteditable="true"],[role="textbox"]')) return 0;
  const linkedMenu = () => (gear.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)
    .map(id => document.getElementById(id)).filter(Boolean);
  const onlyGear = () => [...document.querySelectorAll(gearSelector)].every(el => el === gear || !visible(el));
  if (!onlyGear() && !gear.hasAttribute('aria-controls')) return 0;
  let ownedMenu;
  const menu = () => {
    if (ownedMenu) return ownedMenu.isConnected && visible(ownedMenu) ? ownedMenu : null;
    const candidates = menus();
    if (candidates.length !== 1) return null;
    const candidate = candidates[0], owner = candidate.closest(playerSelector);
    if (owner && owner !== player) return null;
    const linked = linkedMenu();
    if (!player.contains(candidate) && !(linked.length ? linked.some(el => el === candidate ||
      el.contains(candidate) || candidate.contains(el)) : onlyGear())) return null;
    ownedMenu = candidate;
    return ownedMenu;
  };

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
      const timer = setTimeout(finish, 900);
      observer.observe(ownedMenu || document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-a-target', 'aria-expanded', 'hidden'] });
    });
  };
  document.addEventListener('pointerdown', interrupt, true);
  document.addEventListener('keydown', interrupt, true);
  try {
    if (!await currentSession() || !canChange() || menus().length) return 0;
    gear.click();
    opened = true;
    const quality = await waitFor(() => menu()?.querySelector('[data-a-target="player-settings-menu-item-quality"]'));
    if (!quality || !await currentSession() || !canChange()) return 0;
    quality.click();
    const selector = '[data-a-target="player-settings-submenu-quality-option"]';
    if (!await waitFor(() => menu()?.querySelector(selector)) || !canChange()) return 0;
    const candidates = [];
    for (const node of menu().querySelectorAll(selector)) {
      const control = node.matches('input') ? node : node.querySelector('input') || node;
      const label = control.labels?.[0] || node.closest('label') || node;
      const text = label.textContent?.trim() || node.textContent?.trim() || node.getAttribute('aria-label')?.trim() || '';
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
