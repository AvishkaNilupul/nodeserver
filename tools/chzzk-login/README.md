# Naver password login helper

Uses a dedicated installed Google Chrome profile to sign in and export cookies
for the existing CHZZK import dialog. Requires Node.js and Playwright (already
declared by the application). No server deployment or additional API key is needed.

Set `NAVER_ID` and `NAVER_PW` in the environment, then run:

```sh
node tools/chzzk-login/index.js
```

The helper fills the login form, selects **Stay signed in**, and submits once.
Complete any CAPTCHA or two-step verification directly in Chrome. It waits up
to ten minutes and exports only after Naver's authenticated API confirms login.
A previously signed-in profile is checked and reused without another submission.

The default profile is `~/.playwright-naver-profile`. `PROFILE_DIR` selects
another dedicated profile. Use separate profiles and `OUT` files for different
accounts; one run exports one login. Close the helper's previous Chrome window
before starting another run with the same profile.

The default export is `~/.local/share/nodeserver/chzzk-login/naver-cookies.json`.
`OUT` overrides that path. The file is written atomically with owner-only access
and includes the cookie expiry and session metadata expected by the panel.
Logs contain no passwords or cookie values, and no screenshots are captured.
The browser closes on success and on failure.

Import the exported JSON through **CHZZK → Accounts → Import logins**. The
running server updates the matching account and maintains its renewed cookies.
This helper does not automatically upload sessions or run a second farm.
