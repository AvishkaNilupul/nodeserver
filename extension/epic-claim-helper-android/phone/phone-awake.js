// Keep this dedicated claim page awake, including the wait between checkouts.
// Navigation/locking releases a screen lock; reacquire when visible again.
(() => {
  if (globalThis.__epicPhoneAwake) return;
  globalThis.__epicPhoneAwake = true;
  let lock, requesting = false, leaving = false;
  async function keepAwake() {
    if (leaving || document.visibilityState !== 'visible' || lock || requesting ||
        !globalThis.navigator?.wakeLock) return;
    requesting = true;
    try {
      const acquired = await navigator.wakeLock.request('screen');
      if (leaving || document.visibilityState !== 'visible') {
        await acquired.release();
        return;
      }
      lock = acquired;
      acquired.addEventListener('release', () => { if (lock === acquired) lock = null; });
    } catch { /* Low battery or OS policy can refuse; retry while visible. */ }
    finally { requesting = false; }
  }
  function release() {
    const held = lock;
    lock = null;
    if (held) held.release().catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake(); else release();
  });
  globalThis.addEventListener('pagehide', () => { leaving = true; release(); });
  globalThis.addEventListener('pageshow', () => { leaving = false; keepAwake(); });
  setInterval(keepAwake, 5000);
  keepAwake();
})();
