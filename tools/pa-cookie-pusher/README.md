# PA Cookie Pusher

A tiny Chrome/Edge extension that turns the daily PlayerAuctions re-supply into
one click. It does **not** log in for you and **never** touches a captcha — you
sign in yourself, as always. It only replaces the fiddly "open devtools, copy
the whole Cookie header, open the keys modal, paste" step.

## Why this exists

The PlayerAuctions seller session dies ~24h after each browser sign-in, and the
login page is captcha-gated, so the server cannot renew it on its own. The cookie
has to be re-supplied by hand once a day. This makes that hand-off instant, and
the server-side session watchdog now Telegrams you ~1h before the cookie is due
to expire, so you top it up before anything goes dark.

## One-time setup

1. **Server side** — set an install secret (a long random string) on the
   redeemer, in `settings.playerauctionsInstallSecret`. Until it is set, the
   install route does not exist (returns 404), so the feature is off by default.
2. **Load the extension** — open `chrome://extensions`, turn on *Developer mode*,
   click *Load unpacked*, and pick this `pa-cookie-pusher` folder.
3. **Configure it** — click the extension icon → *Settings & fallback*:
   - **Server base URL**: the redeemer's HTTPS origin (no trailing path).
   - **Install secret**: the same string you set on the server.
   - Press **Save settings** and approve the one permission prompt (it asks for
     access to the server URL so it can POST there).

## Daily use

1. Sign in at `member.playerauctions.com` in this browser.
2. Click the extension icon → **Grab & push to server**.
3. It reads your session cookies, installs them on the redeemer, confirms the
   session authenticates, and shows when it will next expire.
4. **Close the PlayerAuctions tab** (the popup reminds you) so the server stays
   the only holder of the session — an open tab can rotate the session and cut
   it short.

### Fallback

If the server is unreachable, use **Copy cookie header** instead and paste it
into the PlayerAuctions credential in the listings keys modal by hand. Same
result, one extra paste.

## What it can and cannot do

- Reads only `playerauctions.com` cookies (including the httpOnly session tokens,
  via the privileged `chrome.cookies` API — that is the whole point).
- POSTs only to the one server URL you configured, only with your secret, only
  to the single install route. That route does exactly one thing: replace the
  PlayerAuctions cookie and confirm it. A leaked secret cannot do anything else.
- Stores your settings in the browser's extension storage; the secret never
  leaves your machine except in the install request to your own server.
