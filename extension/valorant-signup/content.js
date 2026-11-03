(() => {
  let identity, flow, busy = false, halted = false, stage = '', lastMail = 0, code = null;
  const send = message => chrome.runtime.sendMessage(message);
  window.addEventListener('valorant-riot-result', event => {
    try {send({type: 'riot-result', receipt: JSON.parse(event.detail)}).catch(() => {});} catch {}
  });
  async function tick() {
    if (busy || halted || !document.body) return; busy = true;
    try {
      if (!identity) {
        const result = await send({type: 'identity'});
        if (!result?.ok) return;
        identity = result.identity; flow = ValorantSignupFlow.create({document});
      }
      const result = flow.step(identity, code);
      if (result.stage !== stage) {stage = result.stage; await send({type: 'stage', stage});}
      if (stage === 'failed') {halted = true; return;}
      if (stage === 'verification' && Date.now() - lastMail > 8000) {
        lastMail = Date.now(); const result = await send({type: 'verification'});
        if (result?.code) code = result.code;
      }
    } catch { /* Keep the same identity; local UI reports extension/API failures. */ }
    finally {busy = false;}
  }
  setInterval(tick, 1000);
})();
