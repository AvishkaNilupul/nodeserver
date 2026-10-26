# CHZZK cookie keep-alive (2026-10-26)

Adds to `docs/CHZZK-FARM.md`; nothing in that contract is removed.

## Why

Naver answers `getUserStatus` with `Set-Cookie: NID_SES=<new value>` (measured
2026-10-25 through the FR tunnel). Before this change the farm threw that away:
`utils/chzzk/http.js` dropped response headers, `makeClient` built its Cookie
header once, and a worker kept its client for days. The first login worked at
13:53Z on 10-25 and was logged out by 15:11Z. Both live logins were exported
"session only" (로그인 상태 유지 not ticked), so they cannot be re-exported
with a longer life.

We do not know Naver's NID_SES lifetime, or whether an old NID_SES stops working
once Naver issues a new one. The safe behaviour is the browser's: always send
the newest cookie Naver gave you, and ask often enough that it keeps giving one.

**What this does not prove.** Prod data argues against "NID_SES simply expires":
The first login's jar from the 10-25 16:11Z import was never renewed, yet it still read
claims at 10-26 01:34Z (9 h 23 min later); its first jar lived 15 h+. So the 10-25
death may have another cause (e.g. a logout or new sign-in in the browser the
export came from). This change is a safeguard plus faster detection: a dead
login is found within 30 min instead of up to 6 h. It is not a proven cure.

## What changes

1. **Transport** (`http.js`): the answer gains `headers` (Node's lowercased
   response headers). Additive: `{ status, json, text, headers }`.
2. **Cookies** (`cookies.js`): `parseSetCookie(line)` and
   `mergeSetCookies(jar, lines, host, now)` →
   `{ jar, changed: [names], ignored: [names] }`. Pure functions, no values in
   anything they return besides the jar itself.
   - Only accepted from a response host ending in `naver.com`, and only when
     the cookie's `Domain` (if given) also ends in `naver.com`.
   - Same name → value replaced (the jar is flat: one cookie per name, sent to
     every Naver host, as before).
   - New name → added.
   - A deletion (`Max-Age<=0`, `Expires` in the past, or an empty value):
     dropped for ordinary cookies, **ignored for NID_AUT / NID_SES** (their
     names come back in `ignored`). A logged-out login shows up as AUTH on the
     next call anyway, and keeping the old value never makes things worse.
3. **Jar store** (`utils/chzzk/jarStore.js`, new): one mutable holder per
   login: `cookies()`, `absorb(lines, host)`, `replace(jar, generation)`,
   `generation`, and an `onChange(names)` hook.
4. **Client** (`client.js`): `makeClient({ cookies, jar, deviceId, transport })`.
   `jar` is a store; without one a logged-in client makes its own private store
   from `cookies`. The Cookie header is read from the store on **every**
   request, and every CHZZK answer's `set-cookie` goes into the store.
   `egressCountry()` never reads or sends cookies (ipinfo), as before.
5. **Farm** (`chzzkFarm.js`):
   - `this.jars`: accountId → store. `_clientFor(doc)` hands every client of
     one login (worker, login check, code collector) the **same** store, so a
     cookie renewed by the login check reaches the running worker at once.
   - The store's generation is the row's `cookieAt` (import time). A doc with
     a newer `cookieAt` (re-imported, maybe by a side process) replaces the
     store's contents; an equal or older one leaves them alone.
   - On change the farm saves the jar, encrypted, with a compare-and-set:
     `updateOne({ _id, cookieAt: <generation> }, { cookies, cookieRenewedAt,
     $inc cookieRenewals })`. No match means the row was re-imported or
     deleted meanwhile: the store reloads from the row (or is dropped) and the
     renewed old jar is **not** written. Saves run one at a time per login.
   - `_importOne` saves the jar as it stands **after** `userStatus` (that call
     already renews NID_SES), and refreshes the in-memory store if there is one.
   - **Keep-warm**: every 30 min, for each login that is not sold and has
     status ok/untested, call `userStatus` (through `_checkOne`, so status and
     alerts stay one code path). Skipped while egress is not ok (fails
     closed, like every other logged-in call). The 6 h full check stays.
   - Activity: `Naver renewed the login cookie (NID_SES) on <nickname>` —
     cookie **names** only, never values.
6. **Model**: `cookieRenewedAt: Date`, `cookieRenewals: Number`.
7. **Views / panel**: `login.renewedAt`, `login.renewals`; the account drawer
   shows "Cookie renewed".

## Races (review 2026-10-26)

- Every request remembers the store generation it went out with. An answer to a
  request sent before a re-import (store `replace()`) is dropped, so the old
  session's renewed NID_SES never lands in the new jar.
- `_checkOne` writes status with `{ _id, cookieAt: <generation it was sent with> }`,
  so a 401 for the old cookie that arrives after a re-import cannot flag the new
  login.
- A worker remembers the generation it was spawned with; its AUTH writes
  not_logged_in only if the row still holds that cookie, and an aborted worker's
  end never writes. Either way an activity line says what happened.
- Re-importing a login that has a running worker (in-process import) stops that
  worker; the supervisor starts a fresh one on the new jar within 30 s.
- A clear line followed by a new value for the same name in one answer is a
  renewal. The "asked to clear" warning is written at most once per login per 6 h.

## Why 30 minutes

The one measured death fits in a 78-minute window (good at 13:53Z, gone by
15:11Z). A 6 h check can never renew inside that. Every 30 min gives at least
two renewals in any such window. The cost is one GET per login per 30 min: a
browser sends that every time someone opens a CHZZK page. It also finds a dead
login within 30 min instead of up to 6 h.

## Not changed

Egress rules, the worker, the codes collector, routes, the alert pass. No
request goes to nid.naver.com.
