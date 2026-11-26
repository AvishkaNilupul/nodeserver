// Runs only in the isolated extension world on the ordinary Drops inventory.
// Keep this function self-contained: Chrome serializes it for executeScript.
export async function inventoryPage({ mode = 'inspect', account, key, permit }) {
  const text = el => String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  const visible = el => !!el?.isConnected && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const here = () => location.origin === 'https://www.twitch.tv' && /^\/drops\/inventory\/?$/.test(location.pathname);
  const blocked = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some(visible);
  const heading = value => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(el => text(el) === value && visible(el));
  const after = (el, anchor) => !!anchor && !!(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (!here() || window.top !== window) return { error: 'Open the normal Twitch Drops inventory first.' };
  if (!/^[a-z0-9_]{3,25}$/.test(account || '')) return { error: 'Save the companion account first.' };
  for (let i = 0; i < 30 && !(heading('Drops & Rewards') && heading('Drops') && heading('Claimed')); i++) await wait(300);
  if (!heading('Drops & Rewards') || !heading('Drops') || !heading('Claimed')) return { error: 'The English Drops inventory has not loaded or its layout changed.' };
  if (blocked()) return { error: 'A Twitch dialog needs your attention. No rewards were clicked.' };

  function identity() {
    const found = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      if (!visible(link)) continue;
      try {
        const url = new URL(link.href);
        const match = url.pathname.match(/^\/u\/([a-z0-9_]{3,25})\/home\/?$/i);
        const namedHeading = match && [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(el => visible(el) && text(el).toLowerCase() === match[1].toLowerCase());
        if (url.origin === 'https://dashboard.twitch.tv' && namedHeading) found.add(match[1].toLowerCase());
      } catch {}
    }
    return found.size === 1 ? [...found][0] : '';
  }
  let browserAccount = identity(), openedMenu = false;
  const avatar = document.querySelector('button[data-a-target="user-menu-toggle"]') || [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === 'User Avatar');
  if (!browserAccount && visible(avatar)) {
    avatar.click(); openedMenu = true;
    for (let i = 0; i < 10 && !browserAccount; i++) { await wait(200); browserAccount = identity(); }
  }
  if (openedMenu && visible(avatar)) {
    avatar.click();
    // Twitch removes the account-menu dialog on a later render/animation.
    // Wait for our own menu to close before treating a dialog as a blocker.
    await wait(100);
    for (let i = 0; i < 20 && here() && blocked(); i++) await wait(100);
  }
  if (!browserAccount) return { error: 'Could not verify the signed-in Twitch account. Open your avatar menu and check again.' };
  if (browserAccount !== account) return { error: `Inventory is signed in as @${browserAccount}; expected @${account}.` };
  if (!here() || blocked()) return { error: 'The inventory changed while checking the account.' };

  const dropsHeading = heading('Drops'), claimedHeading = heading('Claimed'), rewardsHeading = heading('Rewards');
  const label = button => String(button.getAttribute('aria-label') || text(button)).trim();
  const claimButton = button => label(button) === 'Claim Now' && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button);
  function candidates() {
    const found = [];
    for (const button of [...document.querySelectorAll('button')].filter(claimButton)) {
      // Brand/subscription offers and other parts of Twitch are not drop claims.
      if (!after(button, dropsHeading) || after(button, claimedHeading)) continue;
      let card = button.parentElement;
      for (let i = 0; card && i < 8; i++, card = card.parentElement) {
        const images = [...card.querySelectorAll('img[src]')].filter(visible);
        if (!images.length) continue;
        if (images.length !== 1 || [...card.querySelectorAll('button')].filter(claimButton).length !== 1 || text(card).length > 1200) break;
        const image = images[0];
        const name = (image.alt || text(card).replace(/Claim Now/g, '').trim()).slice(0, 120);
        let imageUrl; try { imageUrl = new URL(image.src); } catch { break; }
        if (!name || imageUrl.protocol !== 'https:') break;
        const candidateKey = `${account}|${imageUrl.origin}${imageUrl.pathname}|${name}`;
        found.push({ key: candidateKey, name, image: imageUrl.origin + imageUrl.pathname, button, card }); break;
      }
    }
    return found.filter((item, _, all) => all.filter(x => x.key === item.key).length === 1);
  }
  const items = candidates();
  if (mode === 'inspect') return { account: browserAccount, ready: items.map(({ key, name }) => ({ key, name })), empty: !!document.body.textContent?.includes('There are no items in your inventory yet.') };
  if (mode !== 'claim') return { error: 'Unknown inventory operation.' };
  const item = items.find(item => item.key === key);
  if (!item) return { delivery: 'cancelled', reason: 'Reward is no longer ready to claim.' };
  function claimedImages() {
    return [...document.querySelectorAll('img[src]')].filter(image => {
      if (!visible(image) || !after(image, heading('Claimed')) || (rewardsHeading && after(image, rewardsHeading))) return false;
      try { const url = new URL(image.src); return url.origin + url.pathname === item.image; } catch { return false; }
    }).length;
  }
  const previousClaimedImages = claimedImages();
  const previouslyMarkedClaimed = /\bClaimed\b/.test(text(item.card));
  const allowed = await chrome.runtime.sendMessage({ type: 'dropsPermit', permit, key, account: browserAccount });
  if (!allowed?.ok || !here() || blocked() || !claimButton(item.button)) return { delivery: 'cancelled', reason: 'Claim stopped before clicking.' };
  item.button.click();
  for (let i = 0; i < 40; i++) {
    await wait(300);
    if (!here()) break;
    if (blocked()) return { delivery: 'unknown', reason: 'Twitch opened a dialog; check the inventory. This reward will not be retried automatically.' };
    if (!previouslyMarkedClaimed && item.card.isConnected && /\bClaimed\b/.test(text(item.card)) && ![...item.card.querySelectorAll('button')].some(claimButton)) return { delivery: 'confirmed' };
    if (claimedImages() > previousClaimedImages) return { delivery: 'confirmed' };
  }
  return { delivery: 'unknown', reason: 'Twitch did not show a confirmed claim. Check the inventory; this reward will not be retried automatically.' };
}
