# renters.html module contract (code against it)

Status: the rebuild is built. Sections 1-13 below were FROZEN during the build
and still describe the design. Amended 2026-08-17 after the post-build audits to
match the shipped code: the cross-module allowlist now names the real entry
points, and two new sections record the accepted deviations from byte-fidelity
and what the audits already verified. Nothing here loosens the rules — the rules
section is unchanged.

Rebuild of `public/renters.html` (872 lines) as small modules in `public/renters/`.
Front-end ONLY. Every API call, URL, request body and rendered field stays
IDENTICAL to the original. No new endpoints, no removed endpoints.

Original file to port from: `/Users/avishkanilupul/projects/nodeserver/public/renters.html`
Idiom to match: `/Users/avishkanilupul/projects/nodeserver/public/renter.html`

## Why this rebuild exists (the bug)

The original builds inline `onclick` handlers by interpolating runtime values
into JS string literals inside an HTML attribute, escaped with `esc()`:

    '<button onclick="delAcct(\'' + a.id + '\',\'' + esc(a.login||"") + '\')">'

`esc()` is HTML-escaping, not JS-string-escaping. The HTML parser decodes
`&#39;` back to `'` BEFORE the JS parser sees it, so a login/password/token
containing `'` or `\` terminates the string early — broken handler, and an
injection vector. Genuinely broken today: `delAcct` (login), `copyText` in
`showCreds` (login:pass, token), `copyLogin` (username). The rest is hardening.

**The fix is structural: no runtime value is ever interpolated into JS source.**

## Rules every module MUST follow

1. NO inline `onclick`/`on*` attributes at all, except the static theme toggle
   in the markup (`onclick="toggleTheme()"`, defined by `/theme.js`).
2. NO `window.foo = ...` handler globals. Register actions (see `RT.on`).
3. Markup carries only IDs and small non-secret scalars in `data-*`.
   Sensitive values (password, token, ClientSecret, email) are NEVER written
   into markup. Get them by looking up the module's loaded array by id, or by
   assigning `el.dataset.copy = value` in JS after insertion.
4. `esc()` is still required for every runtime value rendered into HTML text or
   an attribute value.
5. Modules only REGISTER at load (actions, `RT.reload.*` entries, own
   `addEventListener` on static elements). No fetching at load — `boot.js`
   orchestrates the first paint.
6. Each file must pass `node --check`.

## `core.js` — the spine (loaded first, defines `window.RT`)

```js
window.RT = {
  // dom + format
  $(id),                  // document.getElementById
  esc(s),                 // HTML-escape; same impl as original line 219
  toast(m),               // same impl + same duration formula as original line 218
  api(path, opts),        // same as original lines 220-225. NOTE: renters.html does
                          // NOT redirect on 401/403 (that is renter.html). Keep as-is:
                          // throws Error(d.message || "Request failed ("+res.status+")")
  fmtDate(d), remaining(end),

  // badges (pure -> html string)
  statusBadge(r),         // original 228
  botStatusHtml(bot),     // original 496-501
  botPill(b),             // original 364-370 (online===null => "Checking…")
  scanBadge(status),      // original SCAN_BADGE map 600-605, unknown => pending
  farmCell(a),            // original 554-558
  secret(v, show),        // original 559-562, but `show` is passed IN (accounts.js owns it)
  hostSelectHtml(id),     // original 234-238, uses RT.state.HOSTS

  // modal
  openModal(html),        // set #modal innerHTML + show #overlay
  closeModal(),           // run teardowns, hide overlay, RT.state.CURRENT = null
  modalEl(),              // #modal element
  onClose(fn),            // register an idempotent teardown run by closeModal()

  // action registry — replaces every inline onclick
  on(name, fn),           // fn(el, dataset); el lets a handler do its own busy state

  // shared state
  state: { HOSTS: [], BOTS: [], CURRENT: null },

  // reload registry — modules assign their loader here
  reload: {},             // keys: hosts, botPicker, approvals, renters, bots, accounts, drops
  reloadMany(keys),       // await Promise.all of ONLY the keys present in RT.reload

  copy(text),             // clipboard + toast("Copied") / toast("Copy failed")
};
```

Delegated dispatcher (in `core.js`, on `document`, covers page AND modal):

```js
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, el.dataset);
});
```

`core.js` also owns: overlay backdrop click -> `closeModal()` (original 495),
Escape key -> `closeModal()` (original 848), and `RT.on("closeModal", ...)`.

### The lazy-section rule (replaces `ACCS_LOADED` / `DROPS_LOADED`)

`accounts.js` and `drops.js` assign `RT.reload.accounts` / `RT.reload.drops`
**only after their first successful load**. `reloadMany` skips absent keys, so a
global Refresh never force-fetches a section the operator never opened — this
preserves the original flag semantics exactly.

## `data-*` attribute convention

- `data-act` — action name (required)
- `data-id` — mongo id
- `data-op` — `start` | `stop` | `restart`
- `data-val` — small non-secret scalar (e.g. `"true"`/`"false"` for suspend)
- `data-copy` — assigned in JS only, never rendered into an HTML string

## Cross-module exposure (the ONLY legal coupling)

- `RT.detail.open(id)` — detail.js. Used by bots.js "Manage" (`bots.js:193`,
  `bots.js:203`).
- `RT.detail.reopen()` — detail.js. Re-open `RT.state.CURRENT` if set. Used by
  bots.js after a start/stop/restart (`bots.js:121`) and by accounts.js after a
  scan or a remove (`accounts.js:180`, `accounts.js:193`).
- `RT.accounts.rowsHtml(accs)` — accounts.js (original `accountRows` 606-616).
  Rendered INSIDE detail.js's modal (`detail.js:114`).
- `RT.accounts.load()` — accounts.js. **Lazy-section first-open entry point.**
  `boot.js` calls it directly (`boot.js:54`) for the "Load renter accounts"
  button, the section Refresh button, and an `#accFilter` change.
- `RT.drops.load()` — drops.js. Same role for the drops section
  (`boot.js:57`, published at `drops.js:123`).
- `RT.bots.toggleLogs(id)` — bots.js. Modal "Logs" button (`detail.js:468`).
- `RT.create.botOptionLabel(b)` — create.js (original 242-245). Used by
  detail.js's assign-bot `<select>` (`detail.js:119`).

Anything not on this list must not be reached across modules.

### Why the lazy loaders are on the allowlist and not behind `reloadMany`

`RT.accounts.load` / `RT.drops.load` must be called **directly**. Routing a
first open through `RT.reloadMany(["accounts"])` would be a silent no-op: the
`RT.reload.accounts` key does not exist until the first load succeeds, and
`reloadMany` skips absent keys by design (that is what preserves the original
`ACCS_LOADED` / `DROPS_LOADED` semantics). The result would be a dead first
click on the Load button. `reloadMany` stays the right call for every
*subsequent* refresh, which is why `boot.js:84`'s global Refresh lists both keys.

### Removed from this list (audited 2026-08-17)

- `RT.accounts.reload()` — still published (`accounts.js:260`) but grep found
  **zero callers** in any module. Not a coupling; do not code against it.
- `RT.bots.openLogs(id)` — still published (`bots.js:205`) but grep found zero
  *cross-module* callers. The function itself is live: bots.js calls its own
  local `openLogs` from the `botLogs` action (`bots.js:202`). It is not dead
  code, it is just not a cross-module surface.
- `RT.drops.reload()` — published (`drops.js:124`), zero callers, and was never
  on this list to begin with.

These three are vestigial published shims. Removing them from the `.js` files is
a separate cleanup, deliberately not done as part of a docs-only change; this
section exists so nobody treats them as contract.

## File ownership (original line ranges to port)

| file | owns | original lines |
|---|---|---|
| `core.js` | helpers, badges, modal, dispatcher, state, reload registry | 216-228, 234-238, 364-370, 494-501, 554-562, 600-605, 643-646, 848 |
| `create.js` | hosts load, bot picker, "Add a renter" form | 230-303 |
| `approvals.js` | pending approvals list, reveal/approve/reject modal | 305-339 |
| `bots.js` | rented-bots overview, live pills, scan stat, start/stop/restart, logs | 359-432, 502-548 |
| `accounts.js` | renter accounts section, farm days, reveal secrets, `rowsHtml`, showCreds, delAcct, scanAcct | 473-493, 549-599, 606-642 |
| `drops.js` | rented drops archive | 434-459 |
| `detail.js` | renters list, suspend, detail modal, manual add, pool add, save/assign/password/delete | 341-357, 461-472, 647-715, 716-815 |
| `boot.js` | lazy Load buttons, Refresh wiring, filter changes, logout, init order | 817-867 |

`boot.js` init order (original 850-867): fill header from `/shop/me`
(non-blocking), `await RT.reload.hosts()`, then
`Promise.all([botPicker, approvals, renters, bots])`. Accounts and drops stay
behind their Load buttons.

## Accepted deviations from byte-fidelity (audited 2026-08-17)

The rule at the top is "every API call, URL, request body and rendered field
stays IDENTICAL". These are the only places the shipped rebuild does not match
the original byte-for-byte. Each is accepted and intentional. Do not "restore"
them.

1. **bots.js `botOp` disables the clicked button for the request**
   (`bots.js:114-127`) — `el.disabled = true`, restored in `finally`. The
   original `window.renterBot` (original 502-507) had no busy state, so a double
   click fired two start/stop POSTs.
2. **accounts.js adds an "Account not found" toast** (`accounts.js:230`,
   `accounts.js:235`) — no original counterpart. The original copy buttons
   carried the secret in the handler and needed no lookup; the rebuild looks the
   account up by id, so the miss case needs *some* branch, and a toast beats
   silently copying an empty string.
3. **esc() / encodeURIComponent() added where the original interpolated raw** —
   e.g. `esc(location.origin)` (`create.js:114`, original 297 was raw), and
   `encodeURIComponent(id)` on submission path segments (`approvals.js:70`,
   `approvals.js:120`, `approvals.js:136`). Output is identical for all valid
   data; this only changes behaviour for values that would have produced broken
   HTML or a broken URL anyway.
4. **detail.js renters-list "no bot" cell is a display-bug FIX**
   (`detail.js:60`) — the original built `const bot = r.botFile ? (r.botFile) :
   '<span class="muted">no bot</span>'` and then rendered `esc(bot)` (original
   348-349), so `esc()` HTML-escaped the original's own markup and the row
   printed the literal text `<span class="muted">no bot</span>` on screen. The
   rebuild esc()s only the runtime `r.botFile` and lets the static span be
   markup. This is a real fix, not a regression — the rendered field changes on
   purpose, in the botless case only.

### Claimed but verified NOT a deviation — leave alone

- **accounts.js "Farm days" prompt.** It was reported that the rebuild newly
  names the account's login and newly pre-fills the real remaining days, where
  the original said "this account" and a fixed "15". That is wrong. Original 590
  already read `"Farm "+(a.login||"this account")+...` with default
  `a.farmUntil?String(Math.max(1,Math.ceil((new Date(a.farmUntil)-Date.now())/864e5))):"15"`
  — the login was always used when known, the remaining-days pre-fill was always
  computed, and `"15"` was only ever the fallback for an account with no
  `farmUntil`. `accounts.js:201-206` is a faithful port. Nothing to record and
  nothing to change.

## Verified (audits already run — do not redo)

Run against the shipped modules on 2026-08-17. All clean.

- **Action-name uniqueness / parity.** 27 `RT.on(...)` registrations, no
  duplicate names. Every `data-act` value emitted by a module resolves to a
  registered handler, and every registered handler is reachable from emitted
  markup. The one name that looks unregistered to a naive grep is `closeModal`,
  registered inside core.js via its own local `on` (`core.js:173`) rather than
  `RT.on`.
- **Reload-key parity.** Keys assigned: `hosts`, `botPicker` (create.js),
  `approvals`, `renters`, `bots`, `accounts` (lazy), `drops` (lazy). Every key
  passed to `RT.reloadMany` anywhere is in that set; no typo'd key, no key that
  is written but never read.
- **API parity with the original.** The set of `RT.api()` paths in the modules
  equals the set in `git show HEAD:public/renters.html`: no endpoint added, none
  dropped. (A line-oriented grep appears to lose `/renter-accounts` and
  `/renter-drops`; both are present, wrapped across lines at `accounts.js:88`
  and `drops.js:58`.)
- **DOM id parity.** The 37 static ids in `public/renters.html` match the
  original's static markup exactly — none added, none removed. All 42 ids read
  via `$()` resolve to either that static markup or module-generated markup. The
  24 ids the original built from JS are all emitted by the module that now owns
  them. One id is new: `copyLoginBtn` (`detail.js:211`), which exists only so
  `detail.js:245` can assign `dataset.copy` after insertion — the legal path for
  a secret under rule 3.
- **Injection surface.** Zero `on*` attributes emitted from any module; the only
  `on*` in the page is the static `onclick="toggleTheme()"` the rules permit.
  `window.RT` (`core.js:162`) is the only `window.*` assignment — no handler
  globals survive. No runtime value is interpolated into JS source anywhere, so
  the four originally-broken spots (`delAcct` login, `showCreds` login:pass and
  token, `copyLogin` username) are structurally fixed rather than patched.

## Out of scope — do not touch

`public/renter.html`, `public/bots.html`, any file in `routes/` or `utils/`.
Do not commit, push, scp or deploy. Do not run the full `npm test`.
