import { inventoryPage } from './drops-page.js';

export const DROP_ACCESS = { permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] };
export const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';
export function isInventory(url) {
  try { const parsed = new URL(url); return parsed.origin === 'https://www.twitch.tv' && /^\/drops\/inventory\/?$/.test(parsed.pathname); } catch { return false; }
}

export class DropClaims {
  constructor(api, settings) { this.api = api; this.settings = settings; this.epoch = 0; this.busy = false; this.permit = null; this.serial = Promise.resolve(); }
  async state() { return { enabled: false, history: [], ...((await this.api.storage.local.get('drops')).drops || {}) }; }
  patch(fields) {
    const result = this.serial.then(async () => {
      const current = await this.state();
      const value = { ...current, ...(typeof fields === 'function' ? fields(current) : fields) };
      await this.api.storage.local.set({ drops: value }); return value;
    });
    this.serial = result.catch(() => {}); return result;
  }
  async stop(reason = 'Automatic drop claims are off.') {
    this.epoch++; this.permit = null;
    return this.patch({ enabled: false, status: reason });
  }
  async enable() {
    const epoch = ++this.epoch, s = await this.settings();
    if (s.paused || !/^[a-z0-9_]{3,25}$/.test(s.account)) throw new Error('Resume the companion and save its account first.');
    if (!await this.api.permissions.contains(DROP_ACCESS)) throw new Error('Allow optional Twitch inventory access first.');
    const tab = await this.api.tabs.create({ url: INVENTORY_URL, active: true });
    if (epoch !== this.epoch) return { ok: false };
    await this.patch(current => ({ enabled: true, account: s.account, tabId: tab.id, status: 'Inventory opened. Checking earned rewards…', history: current.history.map(x => x.delivery === 'pending' ? { ...x, delivery: 'unknown', reason: 'Previous claim was interrupted; it will not be retried.' } : x) }));
    if (epoch !== this.epoch) { await this.stop(); return { ok: false }; }
    return { ok: true };
  }
  async authorize(message, sender) {
    const p = this.permit;
    if (!p || p.used || p.expiresAt < Date.now() || sender.id !== this.api.runtime.id || sender.frameId !== 0 || sender.tab?.id !== p.tabId || sender.documentId !== p.documentId || !isInventory(sender.url) || message.permit !== p.id || message.key !== p.key || message.account !== p.account) return { ok: false };
    const [state, s] = await Promise.all([this.state(), this.settings()]);
    if (this.permit !== p || p.used || p.epoch !== this.epoch || !state.enabled || state.account !== s.account || s.paused) return { ok: false };
    p.used = true; return { ok: true };
  }
  async run({ reload = false } = {}) {
    if (this.busy) return;
    this.busy = true; const epoch = this.epoch;
    let replacement;
    try {
      let state = await this.state(); const s = await this.settings();
      if (!state.enabled || s.paused || state.account !== s.account) return;
      if (!await this.api.permissions.contains(DROP_ACCESS)) { await this.stop('Twitch inventory access was removed.'); return; }
      let tab; try { tab = await this.api.tabs.get(state.tabId); } catch { await this.stop('Inventory tab closed. Enable claims to open it again.'); return; }
      if (!isInventory(tab.pendingUrl || tab.url)) { await this.stop('Inventory tab changed. Enable claims to open it again.'); return; }
      let tabId = state.tabId;
      if (reload) {
        // This Chrome session can leave an existing tab blank after a reload.
        // Load a fresh inventory, validate it, then retire only our old tab.
        replacement = await this.api.tabs.create({ url: INVENTORY_URL, active: false, windowId: tab.windowId, index: tab.index + 1 });
        tabId = replacement.id;
      }
      for (let i = 0; i < 30; i++) {
        if (epoch !== this.epoch) return;
        tab = await this.api.tabs.get(tabId);
        if (!isInventory(tab.pendingUrl || tab.url)) throw new Error('Inventory tab changed.');
        if (tab.status !== 'loading') break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      const execute = args => this.api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: inventoryPage, args: [args] });
      const snapshot = (await execute({ mode: 'inspect', account: s.account }))[0];
      if (epoch !== this.epoch) return;
      if (!snapshot?.documentId || snapshot.result?.error || snapshot.result?.account !== s.account) throw new Error(snapshot?.result?.error || 'Could not verify the inventory account.');
      if (replacement) {
        const previous = await this.api.tabs.get(state.tabId);
        if (!isInventory(previous.pendingUrl || previous.url)) throw new Error('Inventory tab changed.');
        if (epoch !== this.epoch) return;
        await this.patch({ tabId });
        replacement = null;
        if (epoch !== this.epoch) return;
        if (previous.active) await this.api.tabs.update(tabId, { active: true });
        const latest = await this.api.tabs.get(previous.id);
        if (!isInventory(latest.pendingUrl || latest.url)) throw new Error('Inventory tab changed.');
        await this.api.tabs.remove(previous.id);
      }
      const ready = snapshot.result.ready || [];
      let confirmed = 0;
      for (const reward of ready.slice(0, 10)) {
        if (epoch !== this.epoch) return;
        state = await this.state();
        if (!state.enabled || state.history.some(x => x.account === s.account && x.key === reward.key && x.delivery !== 'cancelled')) continue;
        const attempt = { id: crypto.randomUUID(), account: s.account, key: String(reward.key).slice(0, 1000), name: String(reward.name).slice(0, 120), at: Date.now(), delivery: 'pending' };
        await this.patch({ history: [...state.history.slice(-199), attempt], status: `Claiming ${attempt.name}…` });
        if (epoch !== this.epoch) return;
        this.permit = { id: crypto.randomUUID(), epoch, tabId: state.tabId, documentId: snapshot.documentId, key: reward.key, account: s.account, expiresAt: Date.now() + 20_000, used: false };
        let result;
        try { result = (await execute({ mode: 'claim', account: s.account, key: reward.key, permit: this.permit.id }))[0]?.result; }
        catch { result = { delivery: 'unknown', reason: 'Inventory changed during claim. Check it before trying again.' }; }
        finally { this.permit = null; }
        const delivery = ['confirmed', 'cancelled', 'unknown'].includes(result?.delivery) ? result.delivery : 'unknown';
        await this.patch(fresh => ({ history: fresh.history.map(x => x.id === attempt.id ? { ...x, delivery, reason: String(result?.reason || result?.error || '').slice(0, 300) } : x) }));
        if (delivery === 'confirmed') confirmed++;
        if (epoch !== this.epoch) return;
        if (delivery === 'unknown') { await this.stop(result?.reason || result?.error || 'Claim result uncertain. Check your inventory.'); return; }
      }
      if (epoch === this.epoch) await this.patch({ lastCheck: Date.now(), status: confirmed ? `Confirmed ${confirmed} earned drop${confirmed === 1 ? '' : 's'}.` : ready.length ? 'Ready rewards were already attempted. Check claim history.' : 'No earned drops ready to claim.' });
    } catch (e) { if (epoch === this.epoch) await this.stop(e.message); }
    finally {
      if (replacement) {
        try { const tab = await this.api.tabs.get(replacement.id); if (isInventory(tab.pendingUrl || tab.url)) await this.api.tabs.remove(tab.id); } catch {}
      }
      this.busy = false;
    }
  }
}
