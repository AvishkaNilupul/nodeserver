// Observe Riot's own normal signup result. Never alter its request or answer a
// challenge. Forward a small receipt, never passwords, cookies or auth tokens.
(() => {
  const nativeFetch = window.fetch;
  function receipt(url, body, result) {
    try {
      const endpoint = new URL(url, location.href);
      if (endpoint.origin !== location.origin || endpoint.pathname !== '/api/v1/login') return null;
      const request = typeof body === 'string' ? JSON.parse(body) : null;
      if (!request || !['signup', 'verification'].includes(request.type)) return null;
      return {requestType: request.type, username: request.type === 'signup' ? request.username : null,
        type: ['success', 'verification', 'error', 'signup'].includes(result.type) ? result.type : 'pending'};
    } catch {return null;}
  }
  function notify(value) {
    // Synchronous dispatch queues the extension message before Riot's response
    // handler can navigate away. postMessage would race that navigation.
    if (value) window.dispatchEvent(new CustomEvent('valorant-riot-result', {detail: JSON.stringify(value)}));
  }
  window.fetch = async function(input, options) {
    const response = await nativeFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (new URL(url, location.href).pathname === '/api/v1/login') {
        const body = options?.body ?? (input instanceof Request ? await input.clone().text() : null);
        // Await only JSON cloning, so the receipt is posted before Riot redirects.
        notify(receipt(url, body, await response.clone().json()));
      }
    } catch {}
    return response;
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url) {
    urls.set(this, url); return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    this.addEventListener('load', () => {
      try {notify(receipt(urls.get(this), body, this.responseType === 'json' ? this.response : JSON.parse(this.responseText)));} catch {}
    }, {once: true});
    return send.apply(this, arguments);
  };
})();
