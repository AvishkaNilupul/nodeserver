// Run before deferred site scripts: a stalled application download can leave
// document_idle waiting forever. Only a genuinely blank assigned page qualifies.
(() => {
  function blankPage() {
    const body = document.body;
    if (!body) return true;
    const visibleControl = [...body.querySelectorAll('input,button,select,iframe')].some(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const minimum = el.tagName === 'IFRAME' ? 80 : 0;
      return rect.width > minimum && rect.height > minimum && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    });
    if (visibleControl) return false;
    const banner = document.getElementById('epicgen-banner');
    return !(body.innerText || '').replace(banner?.innerText || '', '').trim();
  }
  chrome.runtime.sendMessage({ type: 'epicgen-page-watch' }, result => {
    if (!result?.ok) return;
    setTimeout(() => {
      if (blankPage()) chrome.runtime.sendMessage({ type: 'epicgen-page-stalled', sessionId: result.sessionId });
    }, 90000);
  });
})();
