/* Whole Epic + Twitch pairs. Twitch claims and observed game inventory stay
   separate throughout rendering, preview and publication. */
(function (root, factory) {
  const panel = factory();
  if (typeof module === "object" && module.exports) module.exports = panel;
  else { root.SkinAccountsPanel = panel; panel.mount(root.document, root); }
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  const API = "/api/skin-accounts";
  const GROWTH_RATES = [["basicDropUsd", "Basic drop", 0.10], ["premiumDropUsd", "Premium drop", 0.20], ["cosmeticUsd", "New cosmetic", 0.50], ["duplicateCosmeticUsd", "Repeated cosmetic", 0.10], ["apexUsd", "Apex Collection", 1.00]];
  const LABELS = { preparing: "Preparing", ready: "Ready", listed: "On sale", paused: "Paused", attention: "Needs attention", sold: "Sold" };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (v) => v != null && v !== "" && Number.isFinite(Number(v)) ? "$" + Number(v).toFixed(2) : "—";
  const when = (v) => v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toLocaleString() : "Not yet";
  const count = (items) => (items || []).reduce((n, item) => n + (Number.isInteger(item.count) && item.count > 0 ? item.count : 0), 0);
  const safeUrl = (value) => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; } catch (_) { return ""; } };
  const sold = (row) => row.state === "sold" || row.ownershipStatus === "sold";
  const restricted = (row) => sold(row) || row.ownershipStatus !== "owned" || row.state === "attention" || !!(row.recovery && row.recovery.required);
  const pill = (text, tone) => '<span class="sk-pill ' + esc(tone || "") + '">' + esc(text) + "</span>";
  const badge = (state) => pill(LABELS[state] || state || "Preparing", ({ listed: "ok", ready: "accent", attention: "warn" })[state]);
  const button = (action, text, disabled, extra) => '<button type="button" class="btn' + (extra || "") + '" data-action="' + action + '"' + (disabled ? " disabled" : "") + ">" + text + "</button>";
  const fingerprint = (row) => JSON.stringify([row && row.state, row && row.ownershipStatus, row && row.link, row && row.profile, row && row.inventory, row && row.pricing, row && row.listing, row && row.recovery]);

  function createController({ fetch, onChange = () => {} }) {
    const state = { rows: [], summary: {}, worker: {}, selectedId: null, preview: null, busy: false, loaded: false, unauthorized: false, error: "", notice: "" };
    let generation = 0;
    const emit = () => onChange(state);
    function clearAuth() {
      generation++;
      Object.assign(state, { rows: [], summary: {}, worker: {}, selectedId: null, preview: null, unauthorized: true, loaded: false, error: "Sign in with a superadmin account to open Skin Accounts.", notice: "" });
      emit();
    }
    async function request(path, body) {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 25000);
      let response;
      try { response = await fetch(API + path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: abort.signal, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
      catch (error) { if (error.name === "AbortError") throw new Error("The request took too long. Check account status before retrying a change."); throw error; }
      finally { clearTimeout(timeout); }
      if (response.status === 401 || response.status === 403 || (response.redirected && /(?:login|signin)/i.test(response.url || ""))) {
        clearAuth();
        throw new Error(state.error);
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.success !== true) throw new Error(data && data.message || (response.status === 413 ? "The update is too large. Reduce the number of inventory items." : "Could not complete the request. Try again."));
      return data;
    }
    async function run(work, preserveNotice) {
      if (state.busy || state.unauthorized) return null;
      state.busy = true; state.error = ""; if (!preserveNotice) state.notice = ""; emit();
      const started = generation;
      try { return await work(() => started === generation && !state.unauthorized); }
      catch (error) { if (!state.unauthorized) state.error = error.message || "Request failed."; return null; }
      finally { state.busy = false; emit(); }
    }
    function replaceRow(row) {
      if (!row || !row.id) throw new Error("The server did not return an updated account. Refresh before trying again.");
      const index = state.rows.findIndex((r) => r.id === row.id);
      if (index < 0) state.rows.unshift(row); else state.rows[index] = row;
      state.selectedId = row.id;
      state.preview = null;
    }
    return {
      state,
      select(id) { if (state.rows.some((r) => r.id === id)) { state.selectedId = id; state.preview = null; emit(); } },
      selected() { return state.rows.find((r) => r.id === state.selectedId); },
      refresh() { return run(async (current) => {
        const data = await request("/overview");
        if (!current()) return null;
        if (!Array.isArray(data.rows)) throw new Error("Account status was incomplete. Try refreshing again.");
        state.rows = data.rows; state.summary = data.summary || {}; state.worker = data.worker || {}; state.loaded = true;
        if (!state.rows.some((r) => r.id === state.selectedId)) state.selectedId = state.rows[0] && state.rows[0].id || null;
        if (state.preview && state.preview.fingerprint !== fingerprint(this.selected())) state.preview = null;
        return data;
      }, true); },
      candidates(q) { return run(async (current) => { const data = await request("/candidates?q=" + encodeURIComponent(q || "")); return current() ? data : null; }); },
      mutate(action, body, id) { return run(async (current) => {
        const path = id ? "/" + encodeURIComponent(id) + "/" + action : "/" + action;
        const data = await request(path, body || {});
        if (!current()) return null;
        replaceRow(data.row);
        state.notice = ({ enroll: "Account pair reserved. Confirm the link and check its inventory next.", adopt: "Existing listing adopted. Review the linked account and inventory.", link: "Exact account pairing confirmed.", inventory: "Verified inventory saved. Twitch claims have a new comparison baseline.", pricing: "Pricing settings saved.", farm: body.enabled ? "Farming request saved. The farm status below shows when it is running." : "Farming stop requested. Check the status below for confirmation.", pause: "Listing pause completed.", resume: "Listing resumed.", publish: "Listing saved on Eldorado.", recover: "Existing offer verified, paused and attached. Review the account before resuming.", refresh: "Account status checked." })[action] || "Changes saved.";
        return data.row;
      }); },
      preview(id) { return run(async (current) => {
        const data = await request("/" + encodeURIComponent(id) + "/preview", {});
        if (!current()) return null;
        if (!data.preview || typeof data.preview.title !== "string" || typeof data.preview.description !== "string") throw new Error("The listing preview was incomplete. Try again.");
        state.preview = { ...data.preview, rowId: id, fingerprint: fingerprint(state.rows.find((r) => r.id === id)) };
        return state.preview;
      }); },
    };
  }

  function renderItems(items, pending) {
    if (!items || !items.length) return '<p class="muted">' + (pending ? "No new claimed rewards awaiting a game check." : "No game inventory confirmed yet.") + "</p>";
    return '<ul class="sk-items">' + items.map((item) => '<li class="sk-item"><div>' + esc(item.name) + '<small>' + esc(pending ? "Claimed on linked Twitch · awaiting game check" : [item.kind && ({ body: "Car body", reward: "Unopened reward", goal: "Goal explosion", decal: "Decal", other: "Item" })[item.kind], item.paint, item.certification].filter(Boolean).join(" · ")) + '</small></div><span class="sk-item-count">× ' + esc(item.count) + "</span></li>").join("") + "</ul>";
  }

  function renderList(rows, selectedId, query, filter) {
    const q = (query || "").trim().toLowerCase();
    const filtered = rows.filter((r) => (filter === "all" || !filter || r.state === filter || (filter === "preparing" && r.state === "ready") || (filter === "attention" && r.ownershipStatus === "quarantined")) && [r.epic && r.epic.displayName, r.twitch && r.twitch.login, r.gameName].join(" ").toLowerCase().includes(q));
    if (!filtered.length) return '<div class="sk-empty"><b>' + (rows.length ? "No matching accounts" : "Start with one account pair") + '</b>' + (rows.length ? "Try another search or filter." : "Reserve an Epic account and a Twitch account, or adopt an existing listing.") + "</div>";
    return filtered.map((row) => '<button type="button" class="sk-account" data-select="' + esc(row.id) + '" aria-pressed="' + (row.id === selectedId) + '"><span class="sk-account-top"><strong>' + esc(row.epic && row.epic.displayName || "Epic account") + "</strong>" + badge(row.state) + '</span><small>' + esc(row.gameName || "Rocket League") + " · @" + esc(row.twitch && row.twitch.login) + '</small><span class="sk-account-meta"><span>' + count(row.inventory && row.inventory.verified) + " verified" + (count(row.inventory && row.inventory.pending) ? " · " + count(row.inventory.pending) + " pending" : "") + "</span><b>" + money(row.listing && row.listing.priceUsd != null ? row.listing.priceUsd : row.pricing && row.pricing.currentUsd) + "</b></span></button>").join("");
  }

  function renderDetails(row, busy) {
    if (!row) return '<div class="sk-empty">Choose an account to see its collection and listing.</div>';
    const { epic = {}, twitch = {}, link = {}, farm = {}, listing = {}, inventory = {}, pricing = {} } = row;
    const profile = inventory.verifiedAt ? row.profile || {} : {};
    const locked = restricted(row), isSold = sold(row), hasListing = !!listing.id;
    const linkOk = link.status === "verified";
    const url = safeUrl(listing.url);
    const errors = [...new Set([row.lastError, farm.lastError, inventory.scanError].filter(Boolean))];
    let next = "";
    if (isSold) next = "Sold. This pair stays reserved for its buyer. No further farming or listing actions are available.";
    else if (row.recovery && row.recovery.required) next = "A previous publish needs recovery. Find its existing Eldorado offer and recover it here before making further listing changes.";
    else if (row.ownershipStatus === "quarantined" || row.state === "attention") next = "Resolve the issue below, then check the account again. New listing and farming actions are held.";
    else if (!linkOk) next = "Next: inspect Epic Connections and confirm these exact accounts are linked.";
    else if (!inventory.verifiedAt) next = "Next: check Rocket League and save the items actually received.";
    else if (!hasListing) next = "Ready for a listing preview. Farming can keep adding claimed rewards while this pair remains yours.";
    return '<div class="sk-detail-head"><div class="sk-detail-heading"><h2>' + esc(epic.displayName || "Epic account") + "</h2>" + badge(row.state) + '</div><p>' + esc(row.gameName || "Rocket League") + " · " + esc(epic.region || "Region not set") + " · Twitch @" + esc(twitch.login) + '</p><div class="sk-actions">' + button("refresh-row", "Check account", busy) + (!isSold && row.recovery && row.recovery.required ? button("recover", "Recover publish", busy) : "") + (!isSold ? button("preview", "Preview listing", busy) : "") + (!isSold && hasListing && !["paused", "sold", "deleted"].includes(listing.status) ? button("pause", "Pause listing", busy) : "") + (!locked && hasListing && listing.status === "paused" ? button("resume", "Resume listing", busy) : "") + '</div>' + (next ? '<div class="sk-next">' + esc(next) + '</div>' : '') + '</div>' +
      (errors.length ? '<div class="sk-section"><div class="sk-note error">' + errors.map(esc).join("<br>") + "</div></div>" : "") +
      '<div class="sk-section"><div class="sk-section-head"><h3>Account pair</h3>' + (!isSold && row.ownershipStatus === "owned" ? button("link", linkOk ? "Review link" : "Confirm link", busy) : "") + '</div><dl class="sk-facts"><dt>Epic</dt><dd>' + esc(epic.displayName) + '</dd><dt>Twitch</dt><dd>@' + esc(twitch.login) + '</dd><dt>Link</dt><dd>' + (linkOk ? pill("Identity confirmed", "ok") : pill("Needs confirmation", "warn")) + '</dd><dt>Last confirmed</dt><dd>' + esc(when(link.verifiedAt)) + '</dd><dt>Ownership</dt><dd>' + esc(row.ownershipStatus || "Unknown") + '</dd></dl></div>' +
      '<div class="sk-section"><div class="sk-section-head"><h3>Verified in game <span class="muted">· ' + count(inventory.verified) + '</span></h3>' + (!isSold && row.ownershipStatus === "owned" ? button("inventory", "Record game check", busy) : "") + '</div><p class="muted sk-footer">' + esc(profile.level == null ? "Level not checked" : "Level " + profile.level) + ' · ' + esc(profile.rank || "Rank not checked") + ' · ' + esc(profile.credits == null ? "Credits not checked" : profile.credits + " credits") + '</p>' + renderItems(inventory.verified, false) + '<p class="muted sk-footer">Last checked: ' + esc(when(inventory.verifiedAt)) + '</p><div class="sk-pending"><h4>Awaiting game check · ' + count(inventory.pending) + '</h4>' + renderItems(inventory.pending, true) + '<p>New Twitch claims are expected in Rocket League after the next login. Colors and certifications stay unverified until checked in game.</p></div><p class="muted sk-footer">Twitch scan: ' + esc(when(inventory.lastScanAt)) + '</p></div>' +
      '<div class="sk-section"><div class="sk-section-head"><h3>Farming</h3>' + (!isSold && farm.enabled ? button("farm-off", "Stop farming", busy) : !locked ? button("farm-on", "Enable farming", busy || farm.allowed !== true) : "") + '</div><dl class="sk-facts"><dt>Status</dt><dd>' + esc(farm.status || (farm.enabled ? "Requested" : "Off")) + '</dd><dt>Last checked</dt><dd>' + esc(when(farm.lastCheckedAt)) + '</dd></dl>' + (farm.needsReload ? '<p class="sk-note warn">Waiting for the farming host to apply the change.</p>' : "") + (!farm.enabled && farm.allowed !== true && !isSold ? '<p class="muted">Farming can start after this pair passes the ownership and link checks.</p>' : "") + '<p class="muted sk-footer">Runs for this pair while unsold. A sale stops farming; the accounts remain reserved.</p></div>' +
      '<div class="sk-section"><div class="sk-section-head"><h3>Eldorado listing</h3>' + (!locked ? button("pricing", "Pricing settings", busy) : "") + '</div><div class="sk-price-line"><span class="sk-price">' + money(listing.priceUsd != null ? listing.priceUsd : pricing.currentUsd) + '</span><span class="muted">' + (pricing.mode === "market" ? "Market pricing" : pricing.mode === "growth" ? "Collection growth pricing" : "Manual price") + '</span></div><dl class="sk-facts"><dt>Listing</dt><dd>' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Open on Eldorado ↗</a>' : "Not published") + '</dd><dt>Status</dt><dd>' + esc(listing.status || "Not published") + '</dd>' + (pricing.mode !== "manual" ? '<dt>Starting price</dt><dd>' + money(pricing.basePriceUsd) + '</dd><dt>Price range</dt><dd>' + money(pricing.floorUsd) + " – " + money(pricing.ceilingUsd) + '</dd><dt>Proposed price</dt><dd>' + money(pricing.proposedUsd) + '</dd>' : "") + (pricing.mode === "growth" ? '<dt>Growth baseline</dt><dd>' + esc(when(pricing.growthBaselineAt)) + '</dd>' : "") + '</dl>' + (pricing.reason ? '<p class="muted">' + esc(pricing.reason) + '</p>' : "") + (pricing.mode === "growth" ? '<details class="sk-rate-details"><summary>Configured additions</summary><p class="muted">These additions are your pricing rules, not a market valuation.</p><dl class="sk-facts">' + GROWTH_RATES.map(([key,label,fallback]) => '<dt>' + label + '</dt><dd>' + money(pricing.growthRates && pricing.growthRates[key] != null ? pricing.growthRates[key] : fallback) + '</dd>').join("") + '</dl></details>' : "") + '</div><div class="sk-section"><details><summary>Recent activity</summary><ol class="sk-timeline">' + (row.history || []).slice(-12).reverse().map((event) => '<li>' + esc(event.message || event.event) + '<time>' + esc(when(event.at)) + '</time></li>').join("") + '</ol></details></div>';
  }

  function validatePricing(input) {
    const mode = input.mode;
    const floorUsd = Number(input.floorUsd), ceilingUsd = Number(input.ceilingUsd), basePriceUsd = Number(input.basePriceUsd);
    if (!["manual", "market", "growth"].includes(mode) || [input.floorUsd, input.ceilingUsd, input.basePriceUsd].some((n) => n === "" || n == null) || ![floorUsd, ceilingUsd, basePriceUsd].every((n) => Number.isFinite(n) && n >= 0.05 && n <= 10000)) throw new Error("Enter a price and limits between $0.05 and $10,000.");
    if (ceilingUsd < floorUsd || basePriceUsd < floorUsd || basePriceUsd > ceilingUsd) throw new Error("The account price must be inside the lower and upper limits.");
    const result = { mode, floorUsd, ceilingUsd, basePriceUsd };
    if (mode === "growth") {
      result.rates = {};
      for (const [key] of GROWTH_RATES) {
        const raw = input.rates ? input.rates[key] : input["rate-" + key];
        const amount = Number(raw);
        if (raw === "" || raw == null || !Number.isFinite(amount) || amount < 0 || amount > 100) throw new Error("Enter a non-negative amount up to $100 for every growth addition.");
        result.rates[key] = amount;
      }
    }
    return result;
  }
  function validateInventory(items, evidence, confirmed) {
    if (!confirmed) throw new Error("Confirm that you checked these items in the game.");
    if (String(evidence || "").trim().length < 12 || String(evidence).trim().length > 400) throw new Error("Add a short record of the game check (12–400 characters).");
    if (!items.length) throw new Error("Add at least one item actually observed in game.");
    const keys = new Set();
    const clean = items.map((item) => {
      const name = String(item.name || "").trim(), number = Number(item.count);
      if (!name || !Number.isSafeInteger(number) || number < 1 || !["reward", "body", "goal", "decal", "other"].includes(item.kind)) throw new Error("Every item needs a name, type and positive whole quantity.");
      const key = String(item.key || "").trim();
      if (!key || keys.has(key)) throw new Error("Inventory item identifiers must be unique. Remove and re-add the duplicated item.");
      keys.add(key);
      return { key, name, count: number, kind: item.kind, paint: String(item.paint || "").trim(), certification: String(item.certification || "").trim() };
    });
    return { confirm: true, items: clean, evidence: String(evidence).trim() };
  }
  function validateProfile(input) {
    const region = String(input.region || "").trim().toUpperCase(), rank = String(input.rank || "").trim();
    const level = Number(input.level), credits = Number(input.credits);
    if (!/^[A-Z]{2}$/.test(region)) throw new Error("Enter the account’s two-letter region, such as JP.");
    if (!rank || input.level === "" || input.level == null || input.credits === "" || input.credits == null || !Number.isSafeInteger(level) || level < 0 || !Number.isSafeInteger(credits) || credits < 0) throw new Error("Record the actual rank, level and credit balance from the game.");
    return { region, level, rank, credits, platform: "PC" };
  }
  function recoveryOfferId(value) {
    const raw = String(value || "").trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuid.test(raw)) return raw.toLowerCase();
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/\/oa\/([0-9a-f-]{36})\/?$/i);
      if (url.protocol === "https:" && ["www.eldorado.gg", "eldorado.gg"].includes(url.hostname) && !url.username && !url.password && match && uuid.test(match[1])) return match[1].toLowerCase();
    } catch (_) {}
    throw new Error("Enter the existing Eldorado offer ID or its HTTPS offer URL.");
  }

  function inventoryEditorRow(item, key) {
    return '<div class="sk-edit-item" data-item-key="' + esc(item.key || key) + '"><div class="sk-form-grid"><label class="sk-field">Item name<input data-item="name" value="' + esc(item.name || "") + '" placeholder="e.g. Nemesis" maxlength="80" required /></label><label class="sk-field">Quantity<input data-item="count" type="number" min="1" step="1" value="' + esc(item.count || 1) + '" required /></label></div><div class="sk-item-options"><label class="sk-field">Type<select data-item="kind">' + [["body", "Car body"], ["goal", "Goal explosion"], ["decal", "Decal"], ["reward", "Unopened reward"], ["other", "Other"]].map(([value, label]) => '<option value="' + value + '"' + (item.kind === value ? " selected" : "") + '>' + label + "</option>").join("") + '</select></label><label class="sk-field">Paint<input data-item="paint" value="' + esc(item.paint || "") + '" placeholder="As shown in game" maxlength="35" /></label><label class="sk-field">Certification<input data-item="certification" value="' + esc(item.certification || "") + '" placeholder="If present" maxlength="35" /></label><button class="sk-remove" data-action="remove-item" type="button" aria-label="Remove item">×</button></div></div>';
  }

  function mount(doc, win) {
    const $ = (id) => doc.getElementById(id);
    if (!$("skin-app")) return;
    let dialogKind = "", dialogRowId = null, candidates = { epicAccounts: [], twitchAccounts: [] }, addMode = "enroll", serial = 0, destroyed = false;
    const dialog = $("skin-dialog");
    const app = createController({ fetch: win.fetch.bind(win), onChange: render });
    function render() {
      const s = app.state;
      $("skin-error").hidden = !s.error;
      $("skin-error").innerHTML = esc(s.error) + (s.unauthorized ? ' <a href="/admin-login.html">Sign in</a>' : "");
      $("skin-notice").hidden = !s.notice;
      $("skin-notice").textContent = s.notice;
      $("skin-content").hidden = s.unauthorized;
      if (s.unauthorized) { closeDialog(); candidates = { epicAccounts: [], twitchAccounts: [] }; }
      $("skin-summary").innerHTML = s.unauthorized ? "" : [["total", "Accounts"], ["listed", "On sale"], ["farming", "Farming"], ["attention", "Attention"], ["sold", "Sold"]].map(([key, label]) => '<div class="sk-stat' + (key === "attention" && s.summary[key] ? " is-attention" : "") + '"><b>' + (s.loaded ? esc(s.summary[key] || 0) : "—") + '</b><span>' + label + '</span></div>').join("");
      $("skin-worker").innerHTML = s.unauthorized ? "" : '<span>' + (s.busy ? "Checking…" : s.worker.running ? "Automatic checks running" : "Automatic checks idle") + '</span><span>Last check: ' + esc(when(s.worker.lastTickAt)) + '</span>' + (s.worker.lastError ? '<span class="is-error">' + esc(s.worker.lastError) + '</span>' : "");
      $("skin-list").innerHTML = s.unauthorized ? "" : !s.loaded && s.busy ? '<div class="sk-empty">Loading your accounts…</div>' : renderList(s.rows, s.selectedId, $("skin-search").value, $("skin-filter").value);
      $("skin-detail").innerHTML = s.unauthorized ? "" : renderDetails(app.selected(), s.busy);
      doc.querySelectorAll('[data-action="refresh-all"], [data-action="add"]').forEach((el) => { el.disabled = s.busy || s.unauthorized; });
      if (dialog.open) {
        dialog.querySelectorAll('button[type="submit"]').forEach((el) => { el.disabled = s.busy || (dialogKind === "preview" && (!s.preview || !s.preview.canPublish || restricted(app.selected() || {}))); });
        dialog.querySelectorAll('[data-action="load-candidates"]').forEach((el) => { el.disabled = s.busy; });
      }
    }
    function closeDialog() { if (dialog.open) dialog.close(); dialogKind = ""; dialogRowId = null; $("skin-dialog-content").innerHTML = ""; }
    function openDialog(kind, title, content, submitLabel, disabled) {
      dialogKind = kind;
      dialogRowId = app.state.selectedId;
      $("skin-dialog-content").innerHTML = '<form id="skin-form"><div class="sk-dialog-head"><h2 id="skin-dialog-title">' + esc(title) + '</h2><button type="button" data-action="close" aria-label="Close dialog">×</button></div><div class="sk-dialog-body">' + content + '</div><div class="sk-dialog-error" id="skin-dialog-error" role="alert" hidden></div><div class="sk-dialog-foot">' + button("close", "Cancel", false) + (submitLabel ? '<button class="btn btn-primary" type="submit"' + (disabled ? " disabled" : "") + '>' + esc(submitLabel) + '</button>' : "") + '</div></form>';
      if (!dialog.open) dialog.showModal();
    }
    function dialogError(message) { const el = $("skin-dialog-error"); if (el) { el.textContent = message; el.hidden = false; } }
    const evidenceField = (text) => '<label class="sk-field wide">Check record<textarea name="evidence" minlength="12" maxlength="400" placeholder="' + esc(text) + '" required></textarea><small>Record what you checked. Do not enter passwords, tokens or codes.</small></label>';
    function showAdd() {
      const body = '<div class="sk-tabs">' + button("mode-enroll", "Reserve a new pair", app.state.busy) + button("mode-adopt", "Adopt existing listing", app.state.busy) + '</div><p class="muted">' + (addMode === "enroll" ? "Both accounts will be reserved together. Confirm the exact link and inventory before publishing." : "Bring a one-account Rocket League listing into this system. Its stock and delivery identity will be checked before adoption.") + '</p><div class="sk-actions"><input name="candidateSearch" aria-label="Search available accounts" placeholder="Search available stock" /><button class="btn" type="button" data-action="load-candidates">Find accounts</button></div><div class="sk-form-grid">' + (addMode === "enroll" ? '<label class="sk-field wide">Available Epic account<select name="epicAccountId" required><option value="">Choose an Epic account</option>' + (candidates.epicAccounts || []).map((a) => '<option value="' + esc(a.id) + '">' + esc(a.displayName || a.accountId) + (a.region ? " · " + esc(a.region) : "") + '</option>').join("") + '</select></label>' : '<label class="sk-field wide">Existing listing ID<input name="listingId" placeholder="Eldorado or internal listing ID" required /><small>Use the existing offer, so the same account is not published twice.</small></label>') + '<label class="sk-field wide">Twitch login<input name="twitchLogin" list="skin-twitch-candidates" placeholder="Twitch username" autocomplete="off" pattern="[A-Za-z0-9_]+" required /><datalist id="skin-twitch-candidates">' + (candidates.twitchAccounts || []).map((a) => '<option value="' + esc(a.login) + '"></option>').join("") + '</datalist><small>' + (addMode === "adopt" ? "Use the Twitch account already linked to this game account." : "Choose available stock; the server rechecks ownership when reserving.") + '</small></label></div><p class="sk-footer">Need another Epic account? <a href="/epic-accounts.html" target="_blank" rel="noopener">Open the account creator ↗</a></p>';
      openDialog("add", "Add account pair", body, addMode === "enroll" ? "Reserve pair" : "Adopt listing");
      dialog.querySelector('[data-action="mode-' + addMode + '"]').setAttribute("aria-pressed", "true");
    }
    function showLink(row) {
      const epic = row.epic || {}, twitch = row.twitch || {};
      const ready = !!epic.accountId && !!twitch.twitchId;
      openDialog("link", "Confirm the exact account link", '<p class="muted">Open <a href="https://www.epicgames.com/account/connections" target="_blank" rel="noopener noreferrer">Epic Connections ↗</a> and inspect the actual pairing. A Twitch “connected” label alone does not identify the Epic account.</p><dl class="sk-facts"><dt>Epic account</dt><dd>' + esc(epic.displayName) + '</dd><dt>Epic ID</dt><dd class="sk-identity">' + esc(epic.accountId || "Missing — check account first") + '</dd><dt>Twitch account</dt><dd>@' + esc(twitch.login) + '</dd><dt>Twitch ID</dt><dd class="sk-identity">' + esc(twitch.twitchId || "Missing — check account first") + '</dd></dl><div class="sk-form-grid">' + evidenceField("Where and when you verified this exact pairing") + '</div><label class="sk-check"><input type="checkbox" name="confirm" required />I inspected these exact identities and confirmed this Epic account is linked to this Twitch account.</label>', "Save link confirmation", !ready);
    }
    function showInventory(row) {
      const items = row.inventory && row.inventory.verified || [];
      const p = row.inventory && row.inventory.verifiedAt ? row.profile || {} : {};
      const profile = '<div class="sk-form-grid"><label class="sk-field">Account region<input name="region" maxlength="2" pattern="[A-Za-z]{2}" placeholder="JP" value="' + esc(p.region || row.epic && row.epic.region || "") + '" required /></label><label class="sk-field">Level<input name="level" type="number" min="0" step="1" value="' + esc(p.level == null ? "" : p.level) + '" required /></label><label class="sk-field">Rank<input name="rank" placeholder="Unranked" value="' + esc(p.rank || "") + '" required /></label><label class="sk-field">Credits<input name="credits" type="number" min="0" step="1" value="' + esc(p.credits == null ? "" : p.credits) + '" required /></label></div><p class="muted sk-footer">Platform: PC. Publication supports known ranks, levels 0–5000 and 0–10,000 credits. Record the actual values; unsupported profiles stay held for review.</p>';
      openDialog("inventory", "Record the game inventory", '<p class="muted">Save the full current collection you actually checked in Rocket League. Keep unopened rewards as unopened; only record colors and certifications shown in game.</p>' + profile + '<div id="skin-inventory-editor" class="sk-inventory-editor">' + (items.length ? items : [{ kind: "body", count: 1 }]).map((item) => inventoryEditorRow(item, "observed-" + Date.now() + "-" + (++serial))).join("") + '</div>' + button("add-item", "Add item", false) + '<div class="sk-form-grid">' + evidenceField("Game check date, account name and where the items were observed") + '</div><label class="sk-check"><input type="checkbox" name="confirm" required />I checked this full inventory and profile in Rocket League. All currently pending Twitch claims are accounted for in these items. This replaces the verified inventory and clears those pending claims; the original growth-pricing baseline stays unchanged.</label>', "Save verified inventory");
    }
    function showPricing(row) {
      const p = row.pricing || {}, price = p.basePriceUsd == null ? p.currentUsd == null ? row.listing && row.listing.priceUsd : p.currentUsd : p.basePriceUsd;
      const mode = p.mode || "growth";
      const rates = '<details class="sk-rate-details" id="skin-growth-rates"><summary>Growth additions (USD per new reward)</summary><p class="muted">Configured additions, not market values. Existing baseline items are not charged again. Unrecognized rewards hold their value until reviewed.</p><div class="sk-form-grid">' + GROWTH_RATES.map(([key,label,fallback]) => '<label class="sk-field">' + label + '<input name="rate-' + key + '" type="number" min="0" step="0.01" value="' + esc(p.growthRates && p.growthRates[key] != null ? p.growthRates[key] : fallback.toFixed(2)) + '" required /></label>').join("") + '</div></details>';
      openDialog("pricing", "Pricing settings", '<p class="muted">Grow the price as new claims are earned, keep a manual price, or compare matching whole game accounts. Unverified claims remain clearly labeled in the listing.</p><div class="sk-form-grid"><label class="sk-field wide">Price control<select name="mode"><option value="growth"' + (mode === "growth" ? " selected" : "") + '>Collection growth — add for new rewards</option><option value="manual"' + (mode === "manual" ? " selected" : "") + '>Manual — keep my price</option><option value="market"' + (mode === "market" ? " selected" : "") + '>Market — compare whole accounts</option></select></label><label class="sk-field wide">Starting / manual price (USD)<input name="basePriceUsd" type="number" min="0.05" max="10000" step="0.01" value="' + esc(price == null ? "" : price) + '" required /><small>Growth mode adds newly earned rewards to this starting price. In manual mode, this is the listing price.</small></label><label class="sk-field">Minimum price (USD)<input name="floorUsd" type="number" min="0.05" max="10000" step="0.01" value="' + esc(p.floorUsd == null ? "" : p.floorUsd) + '" required /></label><label class="sk-field">Maximum price (USD)<input name="ceilingUsd" type="number" min="0.05" max="10000" step="0.01" value="' + esc(p.ceilingUsd == null ? "" : p.ceilingUsd) + '" required /></label></div>' + rates + '<p class="muted sk-footer">Market mode holds the current price when no reliable full-account comparison is available.</p>', "Save pricing");
      updateRateFields();
    }
    function updateRateFields() {
      const section = $("skin-growth-rates");
      if (!section) return;
      const growth = dialog.querySelector('[name="mode"]').value === "growth";
      section.hidden = !growth;
      section.querySelectorAll("input").forEach((input) => { input.disabled = !growth; });
    }
    function showPreview(row, preview) {
      const canPublish = preview.canPublish && !restricted(row);
      openDialog("preview", "Listing preview", '<p class="muted">Public listing text · ' + money(preview.priceUsd) + '</p><h3>' + esc(preview.title) + '</h3><pre class="sk-preview">' + esc(preview.description) + '</pre>' + ((preview.problems || []).length ? '<div class="sk-note warn"><b>Before publishing</b><ul>' + preview.problems.map((p) => '<li>' + esc(p) + '</li>').join("") + '</ul></div>' : "") + (canPublish ? '<div class="sk-form-grid">' + (!(row.listing && row.listing.id) ? '<label class="sk-field wide">Real inventory image URL<input name="coverUrl" type="url" placeholder="https://…" required /><small>Use an HTTPS image showing this account’s actual inventory.</small></label>' : '<p class="muted wide">The existing offer keeps its inventory photos and private delivery details.</p>') + '</div><label class="sk-check"><input type="checkbox" name="confirm" required />Publish this description and price to Eldorado.</label>' : ""), canPublish ? (row.listing && row.listing.id ? "Update existing listing" : "Publish on Eldorado") : null);
    }
    function showRecover() {
      openDialog("recover", "Recover an existing publish", '<p class="muted">A previous publish has an uncertain result. Find the offer already created in your Eldorado seller listings, then enter its ID or URL below.</p><div class="sk-note">Recovery verifies that the existing private delivery entry belongs to this exact account pair, pauses the offer and attaches it here. It creates no new offer or stock.</div><div class="sk-form-grid"><label class="sk-field wide">Existing Eldorado offer ID or URL<input name="offerId" placeholder="https://www.eldorado.gg/…/oa/…" autocomplete="off" required /><small>Use the actual offer from the earlier publish.</small></label></div><label class="sk-check"><input name="confirm" type="checkbox" required />Verify this existing offer, pause it and attach it to this account pair.</label>', "Verify and recover offer");
    }

    async function handleAction(action, target) {
      const row = app.selected();
      if (action === "close") { if (!app.state.busy) closeDialog(); return; }
      if (action === "remove-item") { target.closest("[data-item-key]").remove(); return; }
      if (action === "add-item") { $("skin-inventory-editor").insertAdjacentHTML("beforeend", inventoryEditorRow({ kind: "other", count: 1 }, "observed-" + Date.now() + "-" + (++serial))); return; }
      if (app.state.busy || app.state.unauthorized) return;
      if (action === "refresh-all") { await app.refresh(); return; }
      if (action === "add") { candidates = { epicAccounts: [], twitchAccounts: [] }; addMode = "enroll"; showAdd(); const result = await app.candidates(""); if (result && dialog.open && dialogKind === "add") { candidates = result; showAdd(); } return; }
      if (action === "mode-enroll" || action === "mode-adopt") { addMode = action.slice(5); showAdd(); return; }
      if (action === "load-candidates") {
        const query = dialog.querySelector('[name="candidateSearch"]').value;
        const savedLogin = dialog.querySelector('[name="twitchLogin"]').value;
        const savedListing = dialog.querySelector('[name="listingId"]') && dialog.querySelector('[name="listingId"]').value;
        const result = await app.candidates(query);
        if (result && dialog.open) { candidates = result; showAdd(); dialog.querySelector('[name="candidateSearch"]').value = query; dialog.querySelector('[name="twitchLogin"]').value = savedLogin; if (savedListing) dialog.querySelector('[name="listingId"]').value = savedListing; }
        else if (app.state.error) dialogError(app.state.error);
        return;
      }
      if (!row) return;
      if (action === "refresh-row") { await app.mutate("refresh", {}, row.id); return; }
      if (sold(row)) return;
      if (action === "recover" && row.recovery && row.recovery.required) { showRecover(); return; }
      if (action === "pause" || action === "farm-off") { await app.mutate(action === "pause" ? "pause" : "farm", action === "pause" ? {} : { enabled: false }, row.id); return; }
      if (action === "preview") { const preview = await app.preview(row.id); if (preview) showPreview(row, preview); return; }
      if (action === "link" && row.ownershipStatus === "owned") { showLink(row); return; }
      if (action === "inventory" && row.ownershipStatus === "owned") { showInventory(row); return; }
      if (restricted(row)) return;
      if (action === "pricing") showPricing(row);
      else if (action === "farm-on" && row.farm && row.farm.allowed) await app.mutate("farm", { enabled: true }, row.id);
      else if (action === "resume") await app.mutate("resume", {}, row.id);
    }
    doc.addEventListener("click", (event) => {
      const selection = event.target.closest("[data-select]");
      if (selection) { app.select(selection.dataset.select); return; }
      const target = event.target.closest("[data-action]");
      if (target && !target.disabled) handleAction(target.dataset.action, target).catch((error) => { if (dialog.open) dialogError(error.message); else { app.state.error = error.message; render(); } });
    });
    dialog.addEventListener("cancel", (event) => { if (app.state.busy) event.preventDefault(); else closeDialog(); });
    dialog.addEventListener("change", (event) => { if (event.target.name === "mode") updateRateFields(); });
    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (app.state.busy || app.state.unauthorized) return;
      const form = event.target, fields = new win.FormData(form), values = Object.fromEntries(fields.entries());
      const row = app.state.rows.find((r) => r.id === dialogRowId);
      try {
        let action = dialogKind, body;
        if (action === "add") { action = addMode; body = { twitchLogin: String(values.twitchLogin || "").trim(), ...(addMode === "enroll" ? { epicAccountId: values.epicAccountId } : { listingId: String(values.listingId || "").trim() }) }; }
        else {
          if (!row || sold(row)) throw new Error("This account is no longer available for changes. Refresh its status.");
          if (["pricing", "preview"].includes(action) && restricted(row)) throw new Error("Resolve this account’s ownership or status issue first.");
          if (action === "recover") {
            if (!values.confirm || !row.recovery || !row.recovery.required) throw new Error("This account no longer needs publish recovery. Check its current status.");
            body = { confirm: true, offerId: recoveryOfferId(values.offerId) };
          } else if (action === "link") {
            if (!values.confirm || !row.epic.accountId || !row.twitch.twitchId || !String(values.evidence || "").trim()) throw new Error("Inspect the exact account IDs and record your confirmation.");
            body = { confirm: true, epicAccountId: row.epic.accountId, twitchId: row.twitch.twitchId, evidence: values.evidence.trim() };
          } else if (action === "inventory") {
            const items = Array.from(form.querySelectorAll("[data-item-key]")).map((el) => ({ key: el.dataset.itemKey, ...Object.fromEntries(Array.from(el.querySelectorAll("[data-item]")).map((input) => [input.dataset.item, input.value])) }));
            body = { ...validateInventory(items, values.evidence, !!values.confirm), profile: validateProfile(values) };
          } else if (action === "pricing") body = validatePricing(values);
          else if (action === "preview") {
            const preview = app.state.preview;
            if (!values.confirm || !preview || !preview.canPublish || preview.rowId !== row.id || preview.fingerprint !== fingerprint(row)) throw new Error("The account changed after this preview. Close it and generate a fresh preview.");
            const coverUrl = safeUrl(values.coverUrl || "");
            if (!(row.listing && row.listing.id) && !coverUrl) throw new Error("Enter an HTTPS URL for a real inventory image.");
            action = "publish"; body = { confirm: true, ...(coverUrl ? { coverUrl } : {}) };
          } else throw new Error("Unknown update.");
        }
        const result = await app.mutate(action, body, dialogKind === "add" ? null : row.id);
        if (result) { closeDialog(); await app.refresh(); }
        else if (app.state.error && !app.state.unauthorized) dialogError(app.state.error);
      } catch (error) { dialogError(error.message); }
    });
    $("skin-search").addEventListener("input", render);
    $("skin-filter").addEventListener("change", render);
    $("skin-theme").addEventListener("click", () => { const dark = doc.documentElement.dataset.theme !== "dark"; doc.documentElement.dataset.theme = dark ? "dark" : "light"; try { win.localStorage.setItem("theme", dark ? "dark" : "light"); } catch (_) {} });
    const timer = win.setInterval(() => { if (!destroyed && !doc.hidden && !dialog.open) app.refresh(); }, 30000);
    win.addEventListener("pagehide", () => { destroyed = true; win.clearInterval(timer); });
    app.refresh();
    return app;
  }
  return { createController, renderItems, renderList, renderDetails, validatePricing, validateInventory, validateProfile, recoveryOfferId, inventoryEditorRow, safeUrl, fingerprint, mount };
});
