# PA Cookie Pusher

A tiny browser extension that keeps the PlayerAuctions seller session alive. On
**Chrome/Edge** it is **zero clicks**: it does **not** log in for you and
**never** touches a captcha — you sign in yourself, as always, and the moment
your sign-in lands the extension grabs the new session cookie and installs it on
the redeemer on its own. No devtools, no copy-paste, no button.

> **On an iPhone?** It also loads in the **Orion** browser — see
> [On an iPhone (Orion browser)](#on-an-iphone-orion-browser). iOS has a catch
> (it may block the extension from reading the session cookie), so the extension
> has a built-in **Check** that tells you for sure, without touching your live
> session. On the phone it's one tap, not zero.

## Why this exists

The PlayerAuctions seller session dies ~24h after each browser sign-in, and the
login page is captcha-gated (Cloudflare Turnstile + reCAPTCHA), so the server
cannot renew it itself. The cookie has to be re-supplied by a human login once a
day. This removes every manual step around that login:

- The server-side watchdog Telegrams you ~1h **before** the cookie is due to
  expire, so you top it up before anything goes dark.
- You open this browser, sign in, and that's it — the extension pushes the new
  session to the server automatically and then closes the PlayerAuctions tab so
  the server stays the one holder of the session.

## The one rule this is built around

PlayerAuctions allows **exactly one live session per account**. Whoever refreshes
last wins; every other copy is revoked. So this extension is a *hand-off*, not a
second live session:

- It pushes **once per login** — keyed on the refresh token changing, which only
  happens on a fresh sign-in. It deliberately ignores the browser's own ~30-min
  access-token refreshes, because re-pushing those would make this browser and
  the server fight for the single session slot and kill it.
- After pushing, it **closes the PlayerAuctions tabs** so this browser goes
  dormant and the server is the sole owner.

Run it in a **dedicated Chrome profile** used only for PlayerAuctions. That keeps
your everyday browsing from ever holding a second PA session, and makes "dormant
after login" automatic.

## One-time setup

1. **Server side** — already done on prod: `settings.playerauctionsInstallSecret`
   is set, so the install route is live. (Until a secret is set the route does
   not exist — 404 — so the feature is off by default. See `SERVER-WIRING.md` for
   a re-host.)
2. **Make a dedicated profile** — Chrome → profile menu → *Add* → e.g. "PA
   Session". Do the rest inside that profile.
3. **Load the extension** — open `chrome://extensions`, turn on *Developer mode*,
   click *Load unpacked*, and pick this `pa-cookie-pusher` folder. Pin it.
4. **Configure it** — click the extension icon → *Settings & fallback*:
   - **Server base URL**: `https://redeemhub.lets.game`
   - **Install secret**: the 32-char string from
     `settings.playerauctionsInstallSecret` on the server.
   - Leave **Auto-push** and **Close PA tabs after pushing** ticked.
   - Press **Save settings** and approve the one permission prompt (access to the
     server URL so it can POST there).

## Daily use

Nothing, until the Telegram reminder. When it arrives:

1. Open the dedicated profile, go to `member.playerauctions.com`, sign in.
2. Done. The toolbar icon shows a green ✓ with the new expiry in its tooltip, the
   PA tabs close themselves, and the server is live again. Open the popup any time
   to see the last auto-push result.

### Fallback

If auto-push ever fails (server unreachable, say), open the extension and press
**Grab & push now**, or **Copy cookie header** and paste it into the
PlayerAuctions credential in the listings keys modal by hand. Same result.

## On an iPhone (Orion browser)

iOS Safari and every iOS browser built on it block normal extensions from
reading **httpOnly** cookies — and the PlayerAuctions session tokens are
httpOnly. **[Orion](https://kagi.com/orion/)** (free, App Store) is the one iOS
browser that can load this extension from a file, but whether Apple lets it read
httpOnly cookies is not documented and can change between iOS versions. So the
first thing you do on the phone is the built-in **Check** — it answers that for
your device, safely, before you rely on it.

1. Install **Orion** from the App Store.
2. Get the extension onto the phone as a folder (AirDrop or iCloud Drive the
   `pa-cookie-pusher` folder, or a `.zip` of it).
3. Orion → **•••** menu → **Extensions** → turn on third-party installs in
   Settings if asked → **+** → install from file → pick the folder/zip.
4. Open the extension's popup → **Settings & fallback** → set the **Server base
   URL** (`https://redeemhub.lets.game`) and the **Install secret**, then
   **Save**.
5. **Run the check.** Open a tab to `member.playerauctions.com` (do **not** sign
   in), then open the popup and tap **Check this device**:
   - **"Ready / Looks good ✓"** → it works here. Sign in, reopen the popup, tap
     **Grab & push now**. Done.
   - **"This browser hides httpOnly cookies…"** → Apple is blocking it on your
     device; the phone route can't work. Use the remote-desktop fallback below.

**On iPhone it is one tap, not zero.** iOS throttles extension background
workers, so the auto-push-the-moment-you-sign-in behaviour is desktop-only. On
the phone: sign in, open the popup, tap **Grab & push now**. The ⚠ one-session
rule still holds — the popup reminds you to close the PA tab after pushing.

**If the check says it's blocked:** control this Mac from the phone with Chrome
Remote Desktop (free) and use the desktop Chrome extension, which already works
zero-click. The Mac has to be on and awake.

## What it can and cannot do

- Reads only `playerauctions.com` cookies (including the httpOnly session tokens,
  via the privileged `chrome.cookies` API — that is the whole point).
- POSTs only to the one server URL you configured, only with your secret, only to
  the single install route. That route does exactly one thing: replace the
  PlayerAuctions cookie and confirm it. A leaked secret cannot do anything else.
- Stores settings in the browser's extension storage; the secret never leaves
  your machine except in the install request to your own server.
- Never automates the login and never touches the captcha.
