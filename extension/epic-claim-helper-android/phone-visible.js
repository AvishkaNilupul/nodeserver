// Android only: while the pairing page or an Epic tab is on screen, tell the
// background page every few seconds. It passes this on to the phone bridge,
// which refuses new claims once no beat has come for a while: with Firefox in
// the background or the phone locked, a claim tab never loads (tested
// 2026-11-03), so a job sent then would only fail and count as a try.
(() => {
  if (globalThis.__epicPhoneVisible) return;
  globalThis.__epicPhoneVisible = true;
  const beat = () => {
    if (document.visibilityState === 'visible') ext.runtime.sendMessage({ type: 'phone-visible' }).catch(() => {});
  };
  beat();
  setInterval(beat, 5000);
  document.addEventListener('visibilitychange', beat);
})();
