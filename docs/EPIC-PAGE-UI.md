# Epic accounts page — layout contract (2026-11-01)

Owner's complaint about `/epic-accounts.html`: "everything looks like a mess, not organized,
loads everything at once, looks bad". This contract is the frozen spec for the tidy-up.
**It changes presentation and loading only. Every API call, confirmation prompt, modal,
element behaviour and server route stays exactly as it is.** No server files change.

## Files

| File | Owner in this change | Role |
|---|---|---|
| `public/epic-page.css` (NEW) | foundation | tokens, sidebar shell, page frame, `ep-` kit, restyled `.card/.btn/.modal`, Claims tab styles |
| `public/epic-tabs.js` (NEW) | foundation | `window.EpicTabs` controller for the three tabs |
| `public/epic-accounts.html` | foundation | head, nav shell, header, tab bar, the three panel roots, Claims tab + its modals |
| `public/epic-claim-batch.js` | foundation | Claim all progress (polls only while Claims is visible) |
| `public/epic-sales.js`, `public/epic-sales.css` | sales agent | Listings & sales tab |
| `public/epic-account-details.js`, `public/epic-account-details.css` | details agent | Account details tab |

Base = live bytes (commit `3219f1e`). The page links CSS/JS with `?v=20261101` so a reload
never mixes old and new files.

## Page frame (static HTML in epic-accounts.html)

```html
<main class="ep-main">
  <header class="ep-head">…<h1>Epic accounts</h1><p>one short line</p></header>
  <div class="ep-tabs" role="tablist" aria-label="Epic accounts">
    <button class="ep-tab" role="tab" id="epic-claims-tab"  data-tab="claims"  aria-controls="epic-claims-panel">Claims <span class="ep-tab-badge" hidden></span></button>
    <button class="ep-tab" role="tab" id="epic-sales-tab"   data-tab="sales"   aria-controls="epic-sales-panel">Listings &amp; sales <span class="ep-tab-badge" hidden></span></button>
    <button class="ep-tab" role="tab" id="epic-details-tab" data-tab="details" aria-controls="epic-details-panel">Account details <span class="ep-tab-badge" hidden></span></button>
  </div>
  <section class="ep-panel" id="epic-claims-panel"  role="tabpanel" aria-labelledby="epic-claims-tab">…</section>
  <section class="ep-panel" id="epic-sales-panel"   role="tabpanel" aria-labelledby="epic-sales-tab" hidden></section>
  <section class="ep-panel" id="epic-details-panel" role="tabpanel" aria-labelledby="epic-details-tab" hidden></section>
</main>
```

The sales and details panels are EMPTY in the HTML; their scripts fill them. Scripts never
create tab buttons or panels any more, and never move elements between panels.

## `window.EpicTabs` (public/epic-tabs.js, loaded before every tab script)

```js
EpicTabs.current()                 // "claims" | "sales" | "details"
EpicTabs.show(name)                // switch tabs; returns false when a guard refused
EpicTabs.on(name, { show, hide, guard })
   // show(): the panel just became visible (also called once, async, right after
   //         on() when `name` is already the current tab). Load data here.
   // hide(): the panel was hidden. Stop timers/polling here.
   // guard(): called before leaving `name`; return false to stay (e.g. unsaved form).
EpicTabs.badge(name, text, tone)   // tab badge; tone "" | "ok" | "warn" | "error" | "accent"; "" text hides it
EpicTabs.arg()                     // the current tab's URL suffix: "#sales/onsale" -> "onsale",
                                   // "#details?account=ID" -> "?account=ID", "#claims" -> ""
EpicTabs.setArg(suffix)            // replaceState to "#<current>" + suffix ("/onsale", "?account=ID", "")
```

URLs: `#claims` (default), `#sales`, `#sales/<section>`, `#details`, `#details?account=<id>`.
Old links `?tab=sales` and `#details?account=…` keep working.

## Kit (public/epic-page.css) — compose these, add as little tab CSS as possible

Tokens: `--bg --surface --surface-2 --line --ink --muted --accent --green --amber --red`
plus `--ep-ok --ep-warn --ep-err --ep-accent-ink`, soft fills `--ep-ok-soft --ep-warn-soft
--ep-err-soft --ep-accent-soft --ep-muted-soft`, `--ep-line-strong --ep-shadow --ep-mono`.
All have dark values (`html[data-theme="dark"]`). Never hard-code a colour in a tab file.

| Class | Markup / meaning |
|---|---|
| `.card` | existing class, restyled: the plain surface box (12px radius, 16px padding) |
| `.ep-card` | structured card, no padding of its own: children `.ep-card-hd`, `.ep-card-bd`, `.ep-card-ft` |
| `.ep-card-hd` | flex row: `<h2 class="ep-card-title">`, optional `<span class="ep-card-meta">` (muted one-liner), optional `<div class="ep-card-actions">` (pushed right) |
| `.ep-card-bd` / `.ep-card-ft` | body (16px padding) / footer (top border, buttons) |
| `.ep-help` | `<details class="ep-help"><summary>How this works</summary><p>…</p></details>` — long explanations live here, collapsed |
| `.ep-stats` + `.ep-stat` | tiles: `<div class="ep-stat is-warn"><span class="ep-stat-label">…</span><span class="ep-stat-value">…</span><span class="ep-stat-hint">…</span></div>`; tones `is-ok/is-warn/is-error` colour the value |
| `.ep-subnav` + `.ep-subtab` | secondary pill tabs inside a panel; `.is-active`; count `<span class="ep-count">12</span>` (tones `is-ok/is-warn/is-error` on the count) |
| `.ep-toolbar` | flex row above a list: search, chips, selects |
| `.ep-search` | `<label class="ep-search"><svg…/><input type="search" placeholder="Search…"></label>` |
| `.ep-chips` + `.ep-chip` | filter chips (`<button class="ep-chip is-on">Ready <span class="ep-chip-count">12</span></button>`) |
| `.ep-badge` | status pill; tones `is-ok is-warn is-error is-accent`; may hold an `.ep-dot` |
| `.ep-dot` | status dot; tones `is-ok is-warn is-error is-muted` (shape changes with tone) |
| `.ep-table-wrap` + `.ep-table` | bordered list table, sticky header; `.is-right` numeric cells; `tr.is-attn` = needs attention |
| `.ep-note` | inline notice; tones `is-ok is-warn is-error` |
| `.ep-empty` | empty state: `<div class="ep-empty"><b>Nothing here</b><span>why / what to do</span></div>` |
| `.ep-more` | footer row for paging: `<div class="ep-more"><span>Showing 20 of 41</span><button class="btn btn-sm">Show more</button></div>` |
| `.ep-kv` | `<dl class="ep-kv"><dt>Key</dt><dd>Value</dd>…</dl>` |
| `.ep-grid` | responsive card grid (auto-fill, min 300px) |
| `.ep-cols` | two columns (2fr/1fr), one column under 1000px |
| `.ep-field`, `.ep-check` | labelled field (label text above input) / checkbox row |
| `.ep-progress` | `<span class="ep-progress"><i style="width:40%"></i></span>` |
| `.ep-muted`, `.ep-small`, `.ep-num`, `.ep-trunc`, `.ep-ok`, `.ep-warn`, `.ep-error` | text helpers |
| `.btn` `.btn-sm` `.btn-primary` `.btn-danger` `.btn-ghost` | existing button classes, restyled (34px / 28px) |
| `.modal-wrap.show > .modal`, `.modal-actions` | existing modal classes, restyled (bottom sheet on phones) |
| `.spin`, `.muted`, `.warn`, `.row`, `.hint` | existing helpers, still defined |

## Rules for every tab

1. Summary first, detail on demand: counts/status at the top, long text in `.ep-help`,
   long lists paged (`Show more`), secondary blocks collapsed.
2. One thing at a time: a tab with many sections uses `.ep-subnav`; only one section shows.
3. Load lazily: fetch only in `show()`, stop timers in `hide()` and while `document.hidden`.
4. Keep every existing element id that code or another file reads, every API call and
   every confirm()/prompt() text. Keep data-* hooks the handlers use.
5. Phones (≤768px): 16px text in fields, full-width buttons where a row would overflow,
   no sideways page scroll; tables become cards (pattern: `td[data-label]::before`).
6. Dark mode must work through the tokens only.
7. No new libraries, no build step, plain ES2019 in the browser.

## Claims tab (public/epic-claims.js + epic-claim-batch.js; foundation)

Stat tiles (accounts, games to claim, need login, library value) → "Free game claims" card
(auto-claim badge, Sync all now / Claim all missing, status line, batch progress, help) →
"Accounts" card (Add account folded away; search, filter chips, sort; compact table, one
line per account, a chevron opens library/details/actions; 20 rows then Show more).
Globals other files use: `toast(msg, err)`, `load()`, `closeModal(id)`.

## Listings & sales tab (public/epic-sales.js + epic-sales.css; sales agent)

`#epic-sales-panel` is empty in the HTML; `init()` fills it once:

1. **Status card** (`.ep-card`): hd = title "Selling status", `<span class="ep-card-meta"
   id="es-updated">` ("Updated 13:05"), actions `#es-sync` "Check Eldorado now" and
   `#es-refresh` "Refresh" (both `btn btn-sm`). bd = `#es-health`: five compact tiles in a
   grid (auto-fit, min ≈200px): `.ep-dot` + small uppercase label + one-line value + muted
   hint — same five items, same texts as `renderHealth()` today. Then an `.ep-help`
   "How this works" holding the old intro paragraph ("Epic accounts on Eldorado, G2G…").
2. **Sub-nav** `.ep-subnav` (role=tablist), `.ep-subtab` buttons with `data-es-section`:
   `onsale` "On sale", `sales` "Sales", `ready` "Ready to list", `dist` "Auto-distribute",
   `stock` "All accounts", `settings` "Settings". `.ep-count` per button (hidden when empty):
   onsale = accounts on sale (stock state "listed"); sales = number of sales (`is-error` when
   any `needsAttention`); ready = ready accounts (`is-ok` when > 0); dist = "Off"/"Plan"/"On"
   (`is-ok` on, `is-accent` plan); stock = all accounts (`is-warn` when any "blocked").
3. **Sections** — one `<div data-es-section="…">` per sub-tab, only the active one shown:
   - `onsale`: three `.ep-card`s. **Eldorado** (`#es-listings`; removed listings folded in a
     `<details>`; "Other Epic offers on your Eldorado account" = `#es-others-card` /
     `#es-others` as a sub-block at the end of this card, shown only when there are any or an
     error). **G2G** (`#es-g2g`). **PlayerAuctions** (`#es-pa`; its "Check PlayerAuctions
     sales" button `#es-pa-check` in the card header actions). Each card header has an
     `.ep-card-meta` summary (e.g. "2 listings · 10 on sale · 0 sold", "1 offer · 16 in G2G
     stock · 0 sold", "0 offers · 4 ready"); the long G2G / PlayerAuctions hint paragraphs move
     into an `.ep-help` at the top of the card body. In each Eldorado listing, the units list is
     folded (`<details>` "10 accounts on this listing"), open when any unit has `missingSince`.
   - `sales`: `.ep-card` "Sales": toolbar of market chips (All / Eldorado / G2G /
     PlayerAuctions with counts) + `#es-sales` table; 20 rows, then Show more.
   - `ready`: `.ep-card` "Ready to list": short hint + the permission `.ep-note is-warn` when
     Eldorado says no; `#es-groups` as an `.ep-grid` of group cards (title, count badge,
     account labels — first 8 then "+N more", warnings, Rocket League hint, the two buttons).
   - `dist`: `.ep-card` `#es-dist-card` "Auto-distribute new accounts": hd meta = mode badge +
     "last run 3 min ago"; body = `.ep-help` with the long explanation, then `#es-dist`:
     mode buttons + description, Preview/Run buttons + last-run line, `.ep-cols` with the
     Markets table (left) and the Limits form (right), the PlayerAuctions owner block, the
     Plan counts line + table (first 10 rows, then "Show all N").
   - `stock`: `.ep-card` "All accounts": toolbar = `.ep-search` + chips (All / Ready / On sale /
     Sold / Can't sell with counts) + `#es-stock` table; 25 rows, then Show more.
   - `settings`: `.ep-card` "Settings": `#es-settings` = the three controls as rows, each with a
     one-line muted description (ids `es-cfg-sync`, `es-cfg-days`, `es-cfg-shared`; same
     confirm text).
4. **Routing:** on show, the section = `EpicTabs.arg()` if valid, else localStorage
   `epic.sales.section` (try/catch), else `onsale`. Switching calls `EpicTabs.setArg("/" + s)`
   and stores it. Old `?tab=sales` links are handled by the controller.
5. **Loading:** `EpicTabs.on("sales", {show, hide})`. show → `load()` (others included),
   then a 60 s refresh while visible (skip when `document.hidden` or a `.es-modal.show` is
   open) that calls `/api/epic/sales/overview?others=0` and keeps the previous `data.others`.
   Refresh button = full load. hide → clear the timer.
6. **Main tab badge** after each load: `EpicTabs.badge("sales", "!", "error")` when the Mac
   proxy is offline, sale tracking is on and its last tick failed, or the Eldorado login
   expires within 3 days; else the on-sale count (no tone), or hidden when 0.
7. **Delete** the old tab-button/panel creation, the MutationObserver, the `?tab=sales`
   handling and the history writes. **Keep** every handler, modal (`buildModals`), API call,
   confirm/prompt text and the `renderDist(force)` typing guard.
8. **Style** with the kit: `pill()` outputs `.ep-badge` (green→is-ok, red→is-error,
   amber→is-warn); tables = `.ep-table-wrap` + `.ep-table`, phone cards via `td[data-label]`.
   Drop CSS the kit now covers.

## Account details tab (public/epic-account-details.js + .css; details agent)

`#epic-details-panel` is empty in the HTML; `init()` fills it once with `.ed-layout`: a grid
of a 300px account list and the form (one column under 900px).

- **List** (`.ep-card`): hd = "Accounts", count meta, `#epic-detail-refresh` (btn-sm
  "Refresh"). bd = `.ep-search` with `#epic-detail-search` (filters label / display name /
  email), then `#epic-detail-list`: one `<button class="ed-item">` per account (label bold +
  truncated; sub line display name · N games; `.ep-badge` SOLD / Needs login), the chosen one
  `.is-on` + `aria-pressed="true"`; scrolls (max ≈60vh, ≈300px on phones). ft = `.ep-help`
  "Bulk tools" with `#epic-detail-samples` + `#epic-detail-backfill` (same behaviour).
  The `<select id="epic-detail-account">` goes away; the list replaces it.
- **Form** (`#epic-detail-form`, `.ep-card`, hidden until chosen; before that an `.ep-empty`
  "Choose an account"): hd = `#epic-detail-name` + `.ep-badge`s (SOLD/Unsold, Login connected
  / Needs login, N games, Password saved / missing); `#epic-detail-summary` stays as the meta
  line. bd = sections with small headings: **Sign-in** (label, email, password, totpSecret),
  **Owner** (firstName, lastName, dateOfBirth), **Location** (country + the three read-only
  creation fields), **Contact (internal)** (phone, address, `#epic-contact-source`,
  `#epic-detail-generate`), **Notes**. A footer bar that sticks to the bottom of the screen
  while the form is long: Save details, Show saved credentials, Copy sale details and
  `#epic-detail-status`. Then `#epic-detail-secrets`, the copy hint, **Owned games**
  (`#epic-detail-games`, in columns).
- **Deep link:** `EpicTabs.arg()` "?account=ID" picks that account on show; choosing calls
  `EpicTabs.setArg("?account=" + id)`.
- **Tabs:** `EpicTabs.on("details", {show: refresh, hide: () => { hideSecrets(); dirty = false; },
  guard: () => !dirty || confirm("Discard unsaved account detail changes?")})`. Delete the old
  tab creation, card moving, keyboard handling and history writes.
- **Keep** every API call and message, `window.load()` after a save, beforeunload and
  visibilitychange behaviour, and the dirty confirm when picking another account.
