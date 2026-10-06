# SOOP farm UI kit

Everything a `tab-*.js` file may use. The page shell (`/soop.html`), `soop.css` and
`core.js` are fixed; a tab file adds no CSS, no `<style>`, no `innerHTML` and no globals
(wrap it in an IIFE). Plain ES2019, one file per tab. Start with `const { el, ui, fmt } = Soop;`.

## 1. Tab lifecycle

1. Your file runs once at page load and calls `Soop.registerTab({ id, label, render, update, badge })`
   with `id` one of `overview bots campaigns accounts inventory activity`.
2. `render(root)` runs **once**, the first time your tab is shown, into an empty `<section>`.
   It never runs before `/state` has loaded and the first `/campaigns` has answered or failed,
   so `Soop.state` is an object and `Soop.campaigns` / `Soop.games` are arrays (maybe empty;
   `Soop.scan` is `null` if that first campaigns call failed).
3. `update()` runs right after `render`, then on every `/state` poll (3 s) and `/campaigns`
   poll (60 s) **while your tab is the visible one**, and again each time the tab is re-shown.
4. `badge()` runs on every poll for every tab, visible or not: return a number or string,
   `{ text, tone }` (`ok | warn | error | accent`), or `null` for none. Read `Soop.state` only.
5. A `render` that throws leaves "This tab could not be shown" + a retry button in your root;
   an `update` that throws is logged once. Neither breaks the page or the other tabs.

**`update()` runs every 3 seconds — never rebuild what the operator is using.** Build the
skeleton in `render`, keep references, and in `update` only call `.set()` / `.update(rows)` /
`.setOptions()` or change `textContent`. Rebuilding an input, an open form or a card list on
each poll drops focus, hover and scroll; for card lists keep a `Map` of key → node and reuse
the nodes. Always read `Soop.state` fresh; never keep a copy across polls.

Polling pauses while the browser tab is hidden. After 3 failed polls core shows "Connection
lost — retrying" and slows to 15 s (`Soop.state` keeps its last value). A 401/403 from any
API call sends the browser to `/admin-login.html`.

## 2. `Soop` — data and plumbing

| Helper | Example |
| --- | --- |
| `state` | `Soop.state.totals.farming` — last `GET /state` body (contract §11) |
| `campaigns`, `games`, `scan` | `Soop.campaigns.filter(c => c.live)` — last `GET /campaigns` body |
| `api.get(path)` | `Soop.api.get("/inventory/account?id=" + encodeURIComponent(id)).then(j => j.items)` |
| `api.post(path, body)` | `Soop.api.post("/bots/stop", { id })` — paths are relative to `/api/soop`; rejects with `Error(message)` (`.status` set) |
| `refresh()` | `Soop.api.post(...).then(Soop.refresh)` — reload `/state` now; never rejects (resolves `null` on failure) |
| `refreshCampaigns(force)` | `Soop.refreshCampaigns(true)` — `true` asks the server to rescan SOOP; never rejects |
| `on(event, fn)` | `const off = Soop.on("state", s => …)` — `"state"` (state), `"campaigns"` (`{campaigns, games, scan}`), `"tab"` (`{ id, params }`); returns an unsubscribe function |
| `go(tabId, params)` | `Soop.go("bots", { create: 1, dropsIdx: c.dropsIdx })` — switches tab, mirrored in `location.hash` |
| `accountById(id)` | `Soop.accountById(id).nick` — `null` when unknown |
| `botById(id)` | `Soop.botById(a.botId)` |
| `campaignById(dropsIdx)` | `Soop.campaignById(s.dropsIdx)` |
| `gameName(gameNo)` | `Soop.gameName("12")` → `"Overwatch"`; unknown → `"Game #12"`; empty → `"Other"` |

Receiving `go()` params: subscribe at the top level of your file. The `"tab"` event fires
after the destination tab has rendered and updated; param values arrive as **strings**.

```js
Soop.on("tab", ({ id, params }) => { if (id === "bots" && params.create) openWizard(params); });
```

## 3. `Soop.el(tag, attrs, ...children)`

The only way to create DOM. Strings and numbers become text nodes (so SOOP's titles, nicks
and messages are always inert); `null` / `false` children are skipped; arrays are flattened.
`attrs` may be omitted: `el("b", "text")`.

```js
el("div", { class: "s-row", dataset: { id: a.id }, onClick: () => open(a) }, ui.dot("ok", "Live"), a.nick)
```

- `class` (string or array), `dataset` (object), `style` (object), `on*` (functions only);
  `value checked disabled hidden selected` are set as properties; `true` makes a bare attribute.
- `href` / `src` are scrubbed: only `http(s):`, `mailto:`, `data:image/` and site-relative
  URLs pass; anything else becomes `#`. `innerHTML` is ignored. SVG tags work (see `s-spark`).

## 4. `Soop.fmt`

| Helper | Example |
| --- | --- |
| `mins(n)` | `fmt.mins(125)` → `"2h 05m"`, `fmt.mins(45)` → `"45m"` |
| `ago(iso)` | `fmt.ago(a.lastCheckedAt)` → `"just now"`, `"3 min ago"`, `"2h 10m ago"`, `"3 days ago"` |
| `until(iso)` | `fmt.until(c.endAt)` → `"in 2h 10m"` (a past time reads as `ago`) |
| `when(iso)` | `fmt.when(c.startAt)` → `"Oct 6, 14:30"` local time |
| `pct(a, b)` | `fmt.pct(30, 240)` → `"13%"` |
| `num(n)` | `fmt.num(12345)` → `"12,345"` |

Every formatter returns `"–"` for missing or invalid input. Show times as `when` plus a relative hint.

## 5. `Soop.ui` — components

Tones: `ok` `warn` `error` `info`, default muted. Colour is never the only signal — put words next to every dot.

| Helper | Example |
| --- | --- |
| `badge(text, tone)` | `ui.badge("Logged out", "error")` |
| `dot(tone, label)` | `ui.dot("warn", "Waiting")` — shape changes with tone; `label` is the screen-reader text |
| `icon(name, size)` | `ui.icon("clock")` — `play stop pause refresh plus trash more check x alert info search download upload edit eye clock chevron copy link external user bot gift` |
| `progress(value, max, tone)` | `const p = ui.progress(30, 240)` then `p.set(45, 240)`; turns green at 100% |
| `stat(label, value, hint, tone)` | `const s = ui.stat("Farming", 8, "of 40")` then `s.set(9, "of 40", "ok")` |
| `empty(title, hint, action)` | `ui.empty("No bots yet", "Create one to start farming.", { label: "Create bot", tone: "primary", onClick })` |
| `button(label, opts)` | `ui.button("Stop", { tone: "danger", size: "sm", icon: "stop", onClick, disabled, title })` — tone `primary danger ghost`; `label: ""` + `icon` + `title` makes an icon button |
| `menu(button, items)` | `ui.menu(ui.button("", { icon: "more", title: "Actions" }), [{ label: "Rename", icon: "edit", onClick }, "-", { label: "Delete", danger: true, disabled, onClick }])` — returns the button; `items` may be a function |
| `chips(opts)` | `ui.chips({ options: [{ value: "live", label: "Live", count: 3 }], value: "live", onChange, multi })` — `.value()`, `.set(v)`, `.setOptions(list)`; `multi` uses arrays |
| `search(opts)` | `ui.search({ placeholder: "Search accounts", onInput: q => … })` — debounced, trimmed; `.value()`, `.set(v)`, `.input` |
| `table(opts)` | see below |

**Buttons, menu items and modal actions take care of async work.** If `onClick` returns a
promise the button shows busy and ignores clicks until it settles; a rejection is shown as an
error toast for you. So this is complete: `onClick: () => Soop.api.post("/bots/resume", { id }).then(Soop.refresh)`.

### `ui.table({ columns, rows, key, onRow, empty, select, onSelect, maxHeight, flush, id })`

```js
const t = ui.table({ key: "id", select: true, onRow: a => openDrawer(a), empty: "No accounts match",
  columns: [{ label: "Account", render: a => el("b", a.nick) }, { label: "Minutes", align: "right", key: "minutes" }],
  rows: Soop.state.accounts });
root.append(t);   …   t.update(rows);   t.selected();   t.clearSelection();
```

- Column: `label`, `key` or `render(row)` (text or node), `align: "right" | "center"`, `width`,
  `hide: "sm"` (dropped under 768 px), `wrap: true` (prose may wrap; other cells stay on one
  line and truncate), `grow: true` (takes the leftover width and truncates — use it on one column).
- `key`: field name or `row => id`; must be unique. `t.selected()` returns those keys as
  **strings**, visible rows only, in row order. `onSelect(keys)` fires on every change.
- `t.update(rows)` is the redraw: it keeps scroll position, selection, the row elements and
  keyboard focus, and waits while one of the row's own menus is open. Call it from `update()`.
- `onRow(row)` fires on click or Enter, but not for clicks on buttons, links, inputs or
  anything inside an element with `data-stop`.
- The header sticks because the table scrolls inside itself (`maxHeight`, default `70vh`).
  `flush: true` drops the border for use inside a `.s-card`. Give an `id` only if you must
  rebuild the table instead of calling `.update()` — selection and scroll then survive that too.

## 6. Layers

| Helper | Example |
| --- | --- |
| `toast(msg, tone)` | `Soop.toast("Imported 3 accounts", "ok")` — `ok warn error info`; `.catch(Soop.toast)` shows an `Error` as an error |
| `confirm(opts)` | `if (await Soop.confirm({ title: "Delete this bot?", body: "Its accounts become free.", danger: true, okLabel: "Delete bot" })) …` |
| `modal(opts)` | `const m = Soop.modal({ title, body, actions: [{ label: "Cancel" }, { label: "Import", tone: "primary", onClick: () => save() }] })` |
| `drawer(opts)` | `const d = Soop.drawer({ title: a.nick, body: node, onClose: off })` — right-hand panel, full width on a phone |

- `modal` / `drawer` options: `title`, `body` (node or text), `actions`, `size` (`"sm" | "lg"`),
  `sticky: true` (a click outside no longer closes it — use for forms), `onClose(result)`.
- An action is `{ label, tone, icon, disabled, onClick(handle) }` or a ready-made node. The
  layer **closes after `onClick` unless it returns `false`** (or a promise of `false`) or fails.
- Handle: `close()`, `setTitle(text)`, `setActions(list)` (for wizard steps), `el`, `body`.
- All three trap focus, close on Escape (topmost first) and return focus to what opened them.
  First focus goes to the element marked `data-autofocus`, else the first field.
- A layer showing live data subscribes with `Soop.on("state", …)` and passes the returned
  function as `onClose`. Destructive actions go through `Soop.confirm` with a verb, not "OK".

## 7. CSS classes

Layout

| Class | Example |
| --- | --- |
| `s-stack` (`is-tight`) | `el("div", { class: "s-stack" }, a, b)` — vertical, 14 px gap (6 px tight) |
| `s-row` | `el("div", { class: "s-row" }, ui.dot("ok"), "Live", ui.badge("3"))` — wrapping inline row |
| `s-spread` | `el("div", { class: "s-spread" }, title, actions)` — ends pushed apart |
| `s-grow` | `el("span", { class: "s-grow s-trunc" }, title)` — takes the free space in a row |
| `s-grid` | `el("div", { class: "s-grid" }, cards)` — auto-fill cards, 300 px minimum |
| `s-grid-2` | `el("div", { class: "s-grid-2" }, main, side)` — 2:1, stacks under 1080 px |
| `s-stats` | `el("div", { class: "s-stats" }, stat1, stat2)` — row of `ui.stat` tiles |
| `s-toolbar` | `el("div", { class: "s-toolbar" }, search, chips, button)` — filter bar above a list |
| `s-scroll` `s-divider` | `el("div", { class: "s-scroll" }, longList)` — 320 px scroll box; `el("hr", { class: "s-divider" })` |
| `s-hide-sm` | `el("span", { class: "s-hide-sm" }, detail)` — hidden under 768 px |

Text

| Class | Example |
| --- | --- |
| `s-muted` `s-small` `s-strong` | `el("span", { class: "s-muted s-small" }, fmt.ago(x))` |
| `s-ok` `s-warn` `s-error` | `el("span", { class: "s-error" }, "Logged out — re-import the cookie")` |
| `s-num` `s-mono` `s-nowrap` | `el("span", { class: "s-num" }, fmt.num(n))` — tabular digits / monospace / no wrap |
| `s-trunc` | `el("span", { class: "s-trunc", title: full }, full)` — one line with an ellipsis |
| `s-eyebrow` | `el("p", { class: "s-eyebrow" }, "Progress")` — small uppercase section label |
| `s-link` | `el("a", { class: "s-link", href: "/api/soop/inventory/export.csv" }, "Export CSV")` |
| `s-code` | `el("span", { class: "s-code" }, code)` — a revealed code; click selects all |

Surfaces

| Class | Example |
| --- | --- |
| `s-card` (`is-ok is-warn is-error`) | `el("section", { class: "s-card is-warn" }, hd, bd)` — tone adds a left edge |
| `s-card-hd` `s-card-title` | `el("div", { class: "s-card-hd" }, el("h2", { class: "s-card-title s-grow" }, "Live now"), btn)` |
| `s-card-bd` `s-card-ft` | `el("div", { class: "s-card-bd s-stack" }, …)` — the card itself has no padding |
| `s-note` (`is-ok is-warn is-error`) | `el("div", { class: "s-note is-warn" }, ui.icon("alert"), el("span", "Drops are never claimed by the system."))` |
| `s-list` `s-list-item` | `el("ul", { class: "s-list" }, el("li", { class: "s-list-item" }, dot, text, btn))` — divided rows |
| `s-kv` | `el("dl", { class: "s-kv" }, el("dt", "Country"), el("dd", "LK"))` |
| `s-thumb` (`is-lg`) | `el("img", { class: "s-thumb", src: c.image, alt: "", loading: "lazy" })` — 40 px (64 px) |
| `s-steps` `s-step` (`is-done is-now`) | `el("ol", { class: "s-steps" }, el("li", { class: "s-step is-done" }, el("b", "30m"), "Spray"))` — reward timeline |
| `s-spark` | `el("svg", { class: "s-spark", viewBox: "0 0 100 30", preserveAspectRatio: "none" }, el("polyline", { points }))` |

Forms (plain elements; buttons, chips and search come from `ui`)

| Class | Example |
| --- | --- |
| `s-field` `s-help` | `el("label", { class: "s-field" }, "Bot name", input, el("span", { class: "s-help" }, "Shown on the Bots tab"))` |
| `s-input` `s-select` `s-textarea` | `el("input", { class: "s-input", value: bot.name })` |
| `s-check` | `el("label", { class: "s-check" }, el("input", { type: "checkbox", checked: on }), "Codes only")` |
| `s-pick` (`is-on`) | `el("button", { type: "button", class: "s-pick is-on", "aria-pressed": "true" }, ui.icon("bot"), el("span", "Everything"))` — selectable card |
| `s-btn` (`is-primary is-danger is-ghost is-sm is-icon`) | `el("a", { class: "s-btn", href: url, download: "" }, ui.icon("download"), "Export CSV")` — only for a link that should look like a button |

Made for you by helpers — do not hand-build: `s-badge` `s-dot` `s-icon` `s-progress` `s-stat`
(`-label -value -hint`) `s-empty` `s-chips` `s-chip` (`-count`, `is-on`) `s-search`
`s-table-wrap` (`is-flush`) `s-table` (`s-td-check s-td-empty is-right is-center is-wrap
is-grow is-click is-selected`) `s-menu` (`-item -sep`) `s-toasts` `s-toast` (`-msg`)
`s-overlay` `s-modal` `s-drawer` (`is-sm is-lg`) `s-ov-hd` `s-ov-title` `s-ov-bd` `s-ov-ft` `s-lock`.

Page shell — core's, leave alone: `s-main` `s-head` `s-status` `s-head-actions` `s-banner` `s-tabs` `s-tab`
(`-label -badge`) `s-panel` `s-loading`, and ids `soopMain soopStatus soopBanner soopTabs soopMenuBtn soopToasts`.

Colour tokens, if a `style` needs one: `--bg --surface --surface-2 --line --ink --muted
--accent --green --amber --red` (fills) and `--s-ok --s-warn --s-err --s-accent-ink` (text).

## 8. Example tab

```js
/* SOOP farm — example tab: a searchable, filterable account list. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  let filter = "all", query = "", stat, chips, table;
  function rows() {
    const q = query.toLowerCase();
    return Soop.state.accounts.filter((a) => (filter === "all" || (filter === "farming") === !!a.session) && (a.nick + " " + a.id).toLowerCase().includes(q));
  }
  const redraw = () => table.update(rows());
  const recheck = (a) => Soop.api.post("/accounts/check", { ids: [a.id] }).then(() => Soop.toast("Checking " + a.nick, "ok"));
  Soop.registerTab({
    id: "accounts", label: "Accounts",
    render(root) {
      stat = ui.stat("Farming", "–");
      chips = ui.chips({ options: [], value: filter, onChange: (v) => { filter = v; redraw(); } });
      table = ui.table({ key: "id", empty: "No accounts match this filter",
        onRow: (a) => Soop.drawer({ title: a.nick, body: "Last checked " + fmt.ago(a.lastCheckedAt) }),
        columns: [{ label: "Account", render: (a) => el("b", a.nick) },
          { label: "Doing now", grow: true, render: (a) => (a.session ? el("span", { class: "s-row" }, ui.dot("ok", "Farming"), a.session.detail) : el("span", { class: "s-muted" }, "Idle")) },
          { label: "Minutes", align: "right", render: (a) => (a.session ? fmt.mins(a.session.minutes) : "–") },
          { label: "", render: (a) => ui.button("Re-check", { size: "sm", icon: "refresh", onClick: () => recheck(a) }) }] });
      root.append(el("div", { class: "s-stack" }, el("div", { class: "s-stats" }, stat),
        el("div", { class: "s-toolbar" }, ui.search({ placeholder: "Search accounts", onInput: (q) => { query = q; redraw(); } }), chips), table));
    },
    update() {
      const t = Soop.state.totals;
      stat.set(t.farming, "of " + fmt.num(t.accounts) + " accounts", t.farming ? "ok" : null);
      chips.setOptions([{ value: "all", label: "All", count: t.accounts }, { value: "farming", label: "Farming", count: t.farming }, { value: "idle", label: "Idle", count: t.accounts - t.farming }]);
      redraw();
    },
    badge() { return Soop.state.totals.dead ? { text: Soop.state.totals.dead, tone: "error" } : null; },
  });
})();
```
