/* SOOP farm — the per-account drawer. Loaded by tab-accounts.js; its one entry
   point is Soop._accountDrawer.open(id). The header and "doing now" follow the
   3 s state poll; inventory and activity are fetched on open and on Refresh only.
   A reward code is never shown here — that is the Inventory tab's job. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const DEAD = "not_logged_in", DAY = 864e5, STALE_MS = 3 * DAY, SOON_MS = 3 * DAY;
  const STATUS = { ok: ["ok", "Ready"], not_logged_in: ["error", "Logged out — re-import its cookie"],
    drops_rejected: ["error", "Refused by the drops site"], untested: [null, "Not checked yet"] };
  const SESSION = { starting: ["info", "Joining"], waiting: [null, "Waiting"], sleeping: [null, "Sleeping"], backoff: ["warn", "Not earning"], stopping: [null, "Stopping"], error: ["error", "Error"] };
  const GROUPS = [["available", "Available — not claimed yet"], ["acquired", "Claimed"], ["expired", "Expired"]];
  const KIND = { code: "Code", link: "Link", ingame: "In-game item" };
  const LEVEL = { error: "error", warn: "warn" };
  const statusOf = (a) => (a.sold ? [null, "Handed over"] : STATUS[a.status] || [null, "Not checked yet"]);
  const sessionOf = (s) => (s.state === "farming" ? (s.credited === true ? ["ok", "Earning"] : ["info", "Watching"]) : SESSION[s.state] || [null, "Working"]);
  const time = (iso) => (iso ? fmt.when(iso) + " · " + fmt.ago(iso) : "–");
  const put = (node, ...kids) => { node.textContent = ""; node.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return node; };
  const muted = (text) => el("p", { class: "s-muted", style: { margin: "0" } }, text);
  const row = (dt, dd) => [el("dt", dt), el("dd", dd)];
  function idleSentence(a, bot) {
    if (a.sold) return "Handed over — someone else owns this SOOP account, so it is not farmed and its codes stay out of bundles.";
    if (a.status === DEAD) return "It cannot farm until its cookie is re-imported.";
    if (!bot) return "Idle — it is not in a bot. Add it to one on the Bots tab.";
    if (bot.state === "stopped") return "Idle — its bot is stopped.";
    if (bot.state === "finished") return "Idle — its bot has finished.";
    return "Idle — its bot has nothing for it to farm right now.";
  }

  let current = null;                            // the one open drawer: { id, close }

  function open(rawId) {
    const id = String(rawId);
    if (current) { if (current.id === id) return; current.close(); }
    let alive = true, syncing = false, headSig = "", nowSig = "", handle = null;
    const leave = (tab, params) => { handle.close(); Soop.go(tab, params); };

    // ---- header + what it is doing now (from Soop.state, redrawn only when they change) ----
    const head = el("div", { class: "s-stack" }), nowBox = el("div", { class: "s-stack is-tight" });
    const soldBtn = ui.button("Mark handed over", { size: "sm", icon: "check", onClick: toggleSold });
    const syncBtn = ui.button("Sync", { size: "sm", icon: "refresh", onClick: sync });
    const actions = el("div", { class: "s-row" },
      ui.button("Re-check", { size: "sm", icon: "refresh", onClick: recheck }), soldBtn,
      ui.button("Edit note", { size: "sm", icon: "edit", onClick: editNote }),
      ui.button("Delete", { size: "sm", tone: "danger", icon: "trash", onClick: remove }),
      ui.button("Refresh", { size: "sm", tone: "ghost", icon: "refresh", title: "Reload this panel's inventory and activity", onClick: () => reload() }));

    function paint() {
      if (!alive) return;
      const a = Soop.accountById(id);
      if (!a) {
        if (headSig !== "gone") { headSig = "gone"; actions.hidden = true; renewSec.hidden = true; put(head, el("div", { class: "s-note is-warn" }, ui.icon("alert"), el("span", "This account is no longer in the farm — it was deleted."))); put(nowBox); }
        return;
      }
      const bot = a.botId ? Soop.botById(a.botId) : null, st = statusOf(a), dead = !a.sold && a.status === DEAD;
      const old = !a.sold && a.cookieAt && Date.parse(Soop.state.now) - Date.parse(a.cookieAt) > STALE_MS;
      const sig = JSON.stringify([a.nick, a.status, a.lastError, a.sold, a.country, a.botId, bot && bot.name, a.note, a.cookieAt, a.lastCheckedAt, a.createdAt, Math.floor(Date.now() / 60000)]);
      if (sig !== headSig) {
        headSig = sig;
        handle.setTitle(a.nick ? id + " · " + a.nick : id);
        soldBtn.lastChild.nodeValue = a.sold ? "Mark ours again" : "Mark handed over";
        syncBtn.disabled = dead; syncBtn.title = dead ? "Logged out — re-import its cookie first" : "Read this account's inventory from SOOP now";
        const trouble = !a.sold && a.status !== "ok" && a.status !== "untested";
        put(head,
          el("div", { class: "s-row" }, ui.dot(st[0], st[1]), el("b", { class: st[0] === "error" ? "s-error" : null }, st[1])),
          trouble && el("div", { class: "s-note " + (dead ? "is-error" : "is-warn") }, ui.icon("alert"),
            el("span", { class: "s-grow" }, (a.lastError || (dead ? "SOOP says this login has ended" : "The drops site did not accept this login")).replace(/[.\s]+$/, "") + ".",
              " Export the cookie again while signed in to sooplive.com and import it — the account keeps its bot and its progress."),
            ui.button("Import", { size: "sm", icon: "upload", onClick: () => leave("accounts", { import: "1" }) })),
          el("dl", { class: "s-kv" },
            row("Login id", el("span", { class: "s-mono" }, id)),
            row("Nickname", a.nick || el("span", { class: "s-muted" }, "None")),
            row("Country SOOP sees", a.country || el("span", { class: "s-muted" }, "Unknown")),
            row("Bot", bot ? el("a", { class: "s-link", href: "#bots?id=" + encodeURIComponent(bot.id), title: "Show this bot", onClick: () => handle.close() }, bot.name || "Bot")
              : el("span", { class: "s-muted" }, "Not in a bot")),
            row("Cookie imported", old ? el("span", { class: "s-warn" }, ui.icon("alert", 14), " " + time(a.cookieAt) + " — SOOP logins have died within about 2 days; re-import it soon") : time(a.cookieAt)),
            row("Last check", a.lastCheckedAt ? time(a.lastCheckedAt) : "Never"),
            row("Added", time(a.createdAt)),
            row("Note", a.note || el("span", { class: "s-muted" }, "No note"))));
      }
      paintRenew(a);
      const s = a.session, nsig = JSON.stringify([s, a.sold, a.status, bot && bot.state]);
      if (nsig !== nowSig) {
        nowSig = nsig;
        if (!s) put(nowBox, muted(idleSentence(a, bot)));
        else {
          const lab = sessionOf(s);
          put(nowBox,
            el("div", { class: "s-row" }, ui.dot(lab[0], lab[1]), el("b", lab[1]), el("span", { class: "s-grow" }, s.detail || "")),
            el("dl", { class: "s-kv" }, row("Campaign", s.title || (s.dropsIdx ? "Campaign #" + s.dropsIdx : "–")), row("Channel", s.channel || el("span", { class: "s-muted" }, "None yet")), row("Since", time(s.since))),
            s.goal > 0 && el("div", { class: "s-stack is-tight" }, el("span", { class: "s-num s-small" }, fmt.mins(s.minutes) + " of " + fmt.mins(s.goal) + " watched (" + fmt.pct(s.minutes, s.goal) + ")"), ui.progress(s.minutes, s.goal)));
        }
      }
      if (syncing && !(Soop.state.inventory && Soop.state.inventory.running)) { syncing = false; loadInventory(); }
    }

    // ---- actions ----------------------------------------------------------------
    function recheck() {
      return Soop.api.post("/accounts/check", { ids: [id] }).then(() => { Soop.toast("Checking " + id + " — its status updates when the check finishes", "ok"); return Soop.refresh(); });
    }
    // "Sold" here means the SOOP account itself left us. We sell codes, not
    // accounts: a login whose codes sold keeps farming and fills new bundles.
    async function toggleSold() {
      const a = Soop.accountById(id);
      if (!a) return null;
      const sold = !a.sold;
      if (sold && !(await Soop.confirm({ title: "Mark " + id + " as handed over?", danger: true, okLabel: "Mark handed over",
        body: "Only for when someone else now owns this SOOP account. Selling its codes never needs this: a login whose codes were sold keeps farming, and its new codes go into new bundles. Handed over, it stops farming and its codes stay out of bundles." }))) return null;
      return Soop.api.post("/accounts/update", { id, sold }).then(Soop.refresh).then(() => { Soop.toast(sold ? id + " is marked handed over — it is no longer farmed" : id + " is ours again — it farms again", "ok"); });
    }
    function editNote() {
      const a = Soop.accountById(id) || {};
      const area = el("textarea", { class: "s-input", rows: "4", maxlength: "500", "data-autofocus": true });
      area.value = a.note || "";
      Soop.modal({ title: "Note for " + id, size: "sm", sticky: true,
        body: el("label", { class: "s-field" }, "Note", area, el("span", { class: "s-help" }, "Shown in the accounts table and here. Up to 500 characters; leave it empty to remove the note.")),
        actions: [{ label: "Cancel" }, { label: "Save note", tone: "primary", onClick: () => Soop.api.post("/accounts/update", { id, note: area.value.trim() }).then(Soop.refresh).then(() => { Soop.toast("Note saved", "ok"); }) }] });
    }
    async function remove() {
      const yes = await Soop.confirm({ title: "Delete " + id + "?", danger: true, okLabel: "Delete account",
        body: "This removes " + id + " from the farm: it stops farming, leaves its bot, and its stored cookie and inventory records are forgotten. Nothing changes on SOOP itself. To bring it back, import its cookie again." });
      if (!yes) return;
      await Soop.api.post("/accounts/delete", { ids: [id] });
      handle.close();
      Soop.toast("Deleted " + id, "ok");
      await Soop.refresh();
    }

    // ---- cookie renewal (the linked Twitch login signs it in to SOOP again) ------------
    let renewSig = "", linkedAs = "", renewBusy = false;
    const renewInfo = el("dl", { class: "s-kv" }), renewNote = el("span", { class: "s-muted s-small" });
    const linkInput = el("input", { class: "s-input", placeholder: "Twitch login", autocomplete: "off", spellcheck: "false", "aria-label": "Twitch login that renews this cookie", style: { flex: "1 1 180px" },
      onInput: () => paintRenewButtons(), onKeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); linkBtn.click(); } } });
    const linkBtn = ui.button("Save", { size: "sm", icon: "link", onClick: saveLink });
    const renewBtn = ui.button("Renew now", { size: "sm", icon: "refresh", onClick: renewNow });
    function paintRenew(a) {
      const linked = a.twitchLogin || "", sig = JSON.stringify([linked, a.renewedAt, a.renewError, Math.floor(Date.now() / 60000)]);
      if (sig !== renewSig) {
        renewSig = sig;
        put(renewInfo,
          row("Twitch login", linked ? el("span", { class: "s-mono" }, linked) : el("span", { class: "s-muted" }, "Not linked")),
          row("Last renewal", a.renewedAt ? time(a.renewedAt) : el("span", { class: "s-muted" }, "Never")),
          a.renewError ? row("Last error", el("span", { class: "s-error" }, a.renewError)) : null);
      }
      if (linked !== linkedAs) { if (linkInput.value.trim() === linkedAs) linkInput.value = linked; linkedAs = linked; }   // never overwrite what the operator is typing
      paintRenewButtons();
    }
    function paintRenewButtons() {
      const a = Soop.accountById(id), linked = (a && a.twitchLogin) || "";
      linkBtn.disabled = renewBusy || !a || linkInput.value.trim() === linked;
      renewBtn.disabled = renewBusy || !a || !linked;
      renewBtn.title = linked ? "Sign in to SOOP again through " + linked + " and store the new cookie" : "Link a Twitch login first";
    }
    // Both buttons stay disabled while either call runs; focus goes back where it was.
    function lockRenew(note, work) {
      const had = document.activeElement;
      renewBusy = true; renewNote.textContent = note; paintRenewButtons();
      return work().finally(() => {
        renewBusy = false; renewNote.textContent = "";
        if (!alive) return;
        paintRenewButtons();
        if (document.activeElement === document.body) (had && !had.disabled ? had : linkInput).focus({ preventScroll: true });
      });
    }
    async function saveLink() {
      const twitchLogin = linkInput.value.trim(), was = (Soop.accountById(id) || {}).twitchLogin || "";
      if (!twitchLogin && was && !(await Soop.confirm({ title: "Unlink " + was + " from " + id + "?", danger: true, okLabel: "Unlink",
        body: "This account's cookie is then no longer renewed by itself. To link it again, type the Twitch login and save." }))) return null;
      return lockRenew("Saving…", () => Soop.api.post("/accounts/twitch-link", { id, twitchLogin }).then((j) => {
        const now = (j && j.twitchLogin) || "";
        if (alive && linkInput.value.trim() === twitchLogin) linkInput.value = now;
        Soop.toast(now ? id + " now renews its cookie through the Twitch login " + now : id + " is no longer linked to a Twitch login", "ok");
        return Soop.refresh();
      }));
    }
    function renewNow() {
      const linked = (Soop.accountById(id) || {}).twitchLogin || "";
      return lockRenew("Signing in again through " + linked + "…", () => Soop.api.post("/accounts/renew", { id }).then((j) => {
        const list = (j && j.results) || [], r = list.find((x) => String(x.id) === id) || list[0];
        if (r && r.ok) Soop.toast("Renewed the cookie of " + id, "ok");
        else Soop.toast("Could not renew the cookie of " + id + (r && (r.detail || r.reason) ? ": " + (r.detail || r.reason) : ""), "error");
        return Promise.all([Soop.refresh(), loadActivity()]);
      }));
    }

    // ---- inventory (fetched on open, on Refresh and after a sync) ------------------
    const invBox = el("div", { class: "s-stack" }, muted("Loading inventory…")), invNote = el("span", { class: "s-muted s-small" });
    function item(it) {
      const exp = it.expiresAt ? Date.parse(it.expiresAt) : NaN, soon = it.division === "available" && exp - Date.parse(Soop.state.now) < SOON_MS;
      const when = it.division === "expired" ? "Expired " + (it.expiresAt ? time(it.expiresAt) : "")
        : it.division === "acquired" ? "Claimed" + (it.receivedAt ? " " + time(it.receivedAt) : "")
        : it.expiresAt ? "Expires " + fmt.when(it.expiresAt) + " · " + fmt.until(it.expiresAt) : "No expiry date given";
      return el("li", { class: "s-list-item", style: { paddingLeft: "0", paddingRight: "0" } },
        it.image ? el("img", { class: "s-thumb", src: it.image, alt: "", loading: "lazy" }) : ui.icon("gift", 20),
        el("div", { class: "s-grow s-stack is-tight" },
          el("b", { title: it.nameRaw && it.nameRaw !== it.name ? it.nameRaw : null }, it.name || it.nameRaw || "Unnamed reward"),
          el("span", { class: "s-muted s-small" }, [it.gameName || Soop.gameName(it.gameNo), KIND[it.kind]].filter(Boolean).join(" · ")),
          el("span", { class: "s-small " + (soon ? "s-warn" : "s-muted") }, soon && ui.icon("clock", 14), soon ? " " : "", when),
          (it.hasCode || it.needsLink) && el("span", { class: "s-row" }, it.hasCode && ui.badge("Has a code", "info"), it.needsLink && ui.badge("Needs a linked game account", "warn"))));
    }
    function drawInventory(items) {
      const latest = items.reduce((m, it) => (it.syncedAt && it.syncedAt > m ? it.syncedAt : m), "");
      invNote.textContent = latest ? "Last read from SOOP " + fmt.ago(latest) : "";
      if (!items.length) { put(invBox, ui.empty("No rewards recorded for this account", syncBtn.disabled ? "Its SOOP inventory can be read again once its cookie is re-imported." : "Press Sync to read its SOOP inventory now.")); return; }
      put(invBox,
        GROUPS.map(([div, label]) => {
          const list = items.filter((it) => it.division === div);
          return list.length ? el("div", { class: "s-stack is-tight" }, el("b", { class: "s-small" }, label + " (" + list.length + ")"), el("ul", { class: "s-list" }, list.map(item))) : null;
        }).filter(Boolean),
        el("p", { class: "s-muted s-small", style: { margin: "0" } }, "Codes are never shown here, and nothing is claimed for you. Reveal a code on the Inventory tab."));
    }
    function loadInventory() {
      return Soop.api.get("/inventory/account?id=" + encodeURIComponent(id)).then((j) => { if (alive) drawInventory(j.items || []); },
        (e) => { if (alive) put(invBox, el("div", { class: "s-note is-error" }, ui.icon("alert"), el("span", "The inventory could not be loaded: " + e.message))); });
    }
    function sync() {
      return Soop.api.post("/inventory/sync", { ids: [id] }).then(() => { syncing = true; invNote.textContent = "Reading this account's inventory from SOOP…"; return Soop.refresh(); });
    }

    // ---- recent activity ----------------------------------------------------------
    const actBox = el("div", null, muted("Loading activity…"));
    function loadActivity() {
      return Soop.api.get("/activity?accountId=" + encodeURIComponent(id) + "&limit=30").then((j) => {
        if (!alive) return;
        const list = j.entries || [];
        put(actBox, list.length ? el("ul", { class: "s-list" }, list.map((e) => el("li", { class: "s-list-item", style: { paddingLeft: "0", paddingRight: "0" } },
          ui.dot(LEVEL[e.level] || null, e.level === "error" ? "Error" : e.level === "warn" ? "Warning" : "Info"),
          el("span", { class: "s-grow" + (e.level === "error" ? " s-error" : "") }, e.msg || ""),
          el("span", { class: "s-muted s-small s-nowrap", title: fmt.when(e.at) }, fmt.ago(e.at)))))
          : muted("Nothing has been recorded for this account yet."));
      }, (e) => { if (alive) put(actBox, el("div", { class: "s-note is-error" }, ui.icon("alert"), el("span", "The activity could not be loaded: " + e.message))); });
    }
    const reload = () => Promise.all([loadInventory(), loadActivity(), Soop.refresh()]);

    // ---- assemble -------------------------------------------------------------------
    const section = (title, extras, content) => el("section", { class: "s-stack is-tight" }, el("div", { class: "s-spread" }, el("p", { class: "s-eyebrow" }, title), el("span", { class: "s-row" }, extras)), content);
    const tabLink = (label, tab, params) => ui.button(label, { size: "sm", tone: "ghost", icon: "external", onClick: () => leave(tab, params) });
    const renewSec = el("div", { class: "s-stack" },
      section("Cookie renewal", [renewNote, renewBtn], el("div", { class: "s-stack is-tight" }, renewInfo,
        el("div", { class: "s-field" }, el("span", "Linked Twitch login"), el("div", { class: "s-row" }, linkInput, linkBtn),
          el("span", { class: "s-help" }, "When this login is logged out or refused by the drops site, the server signs in to SOOP again through this Twitch login and stores the new cookie. Leave the box empty and save to unlink.")))),
      el("hr", { class: "s-divider" }));
    const body = el("div", { class: "s-stack" },
      actions, head, el("hr", { class: "s-divider" }),
      section("Doing now", null, nowBox), el("hr", { class: "s-divider" }),
      renewSec,
      section("Inventory", [invNote, syncBtn, tabLink("Open in Inventory", "inventory", { account: id })], invBox), el("hr", { class: "s-divider" }),
      section("Recent activity", tabLink("All activity", "activity", { accountId: id }), actBox));
    const off = Soop.on("state", paint);
    const mine = { id, close: () => handle.close() };
    handle = Soop.drawer({ title: id, body, onClose: () => { alive = false; off(); if (current === mine) current = null; } });
    current = mine;
    paint();
    loadInventory(); loadActivity();
  }

  Soop._accountDrawer = { open };
})();
