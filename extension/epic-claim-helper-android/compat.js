// Firefox for Android shim, loaded before the helper's own scripts. The build
// rewrites the Chrome helper's `chrome.` calls to `ext.`, so the same code runs
// on Firefox's promise-based `browser` API.
(() => {
  if (globalThis.ext) return;
  const api = globalThis.browser || globalThis.chrome;
  const pick = name => { try { return api[name]; } catch { return undefined; } };
  const ext = {
    runtime: pick('runtime'),
    storage: pick('storage'),
    tabs: pick('tabs'),
    alarms: pick('alarms'),
    cookies: pick('cookies'),
  };
  // Firefox for Android has no browsingData API. Chrome's
  // removeCookies({origins}) clears the whole registrable domain of each
  // origin, so do the same here: every *.epicgames.com cookie, partitioned
  // ones included. Epic's logout endpoint is still never called.
  ext.browsingData = {
    async removeCookies({ origins = [] } = {}) {
      for (const origin of origins) {
        const site = new URL(origin).hostname.split('.').slice(-2).join('.');
        const list = await ext.cookies.getAll({ domain: site, partitionKey: {} });
        await Promise.all(list.map(c => ext.cookies.remove({
          url: 'https://' + c.domain.replace(/^\./, '') + c.path,
          name: c.name,
          storeId: c.storeId,
          ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
          ...(c.firstPartyDomain ? { firstPartyDomain: c.firstPartyDomain } : {}),
        }).catch(() => null)));
      }
    },
  };
  globalThis.ext = ext;
  // Background page only: run each claim in the helper tab already on screen
  // instead of a new tab. Epic's phone layout has no account name, so the
  // checkout's account check can never pass there. Firefox's desktop mode
  // ("Always request desktop site") gives the desktop layout, but only to tabs
  // Firefox itself opens, never to tabs an add-on opens (tested 2026-11-03).
  // So the claim reuses the active pairing-page or Epic tab, and when the helper
  // would close that tab, it goes back to the pairing page instead.
  if (api.tabs) {
    const helperPage = url => /^http:\/\/127\.0\.0\.1:\d+\/|^https:\/\/([\w-]+\.)?epicgames\.com\//.test(url || '');
    // Kept in session storage: Firefox may unload this background page mid-claim.
    const REUSED = 'epicclaim.android.reusedTab';
    ext.tabs = {
      async create(props) {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        if (!tab || !helperPage(tab.url)) return api.tabs.create(props);
        await api.storage.session.set({ [REUSED]: tab.id });
        return api.tabs.update(tab.id, { url: props.url, active: true });
      },
      async remove(id) {
        const { [REUSED]: reused } = await api.storage.session.get(REUSED);
        if (id !== reused) return api.tabs.remove(id);
        const { 'epicclaim.connection': c } = await api.storage.local.get('epicclaim.connection');
        return api.tabs.update(id, { url: (c ? c.origin : 'http://127.0.0.1:8123') + '/connect' });
      },
      get: id => api.tabs.get(id),
      update: (id, props) => api.tabs.update(id, props),
      onUpdated: api.tabs.onUpdated,
    };
  }
  // Background page only (content scripts have no tabs API): pass the
  // "on screen" beats from phone-visible.js to the paired bridge, at most one
  // every 4 s. The message type has no epicclaim- prefix, so the helper's own
  // listener ignores it.
  if (ext.tabs) {
    let lastBeat = 0;
    ext.runtime.onMessage.addListener(msg => {
      if (msg?.type !== 'phone-visible' || Date.now() - lastBeat < 4000) return;
      lastBeat = Date.now();
      ext.storage.local.get('epicclaim.connection').then(({ 'epicclaim.connection': c }) => {
        if (!c) return;
        return fetch(c.origin + '/phone/visible', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + c.token },
          signal: AbortSignal.timeout(5000),
        });
      }).catch(() => {});
    });
  }
})();
