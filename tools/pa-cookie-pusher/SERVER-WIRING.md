# Server wiring for the one-click hand-off

`routes/paSessionInstallRoutes.js` must be mounted **before** the `enforce2fa`
cascade in `server.js` (the extension carries no admin session). It is committed
here as a note rather than as a `server.js` diff because this checkout's
`server.js` also carries unrelated in-progress work (`accountApiRoutes`) that
must not be swept into this change.

Two blocks, applied onto whatever `server.js` is already deployed:

**1. With the other route requires** (right after the `playerauctionsRoutes` require):

```js
// Token-gated (NOT session/2fa gated) one-click cookie hand-off — mounted early,
// before the admin auth cascade, because the browser extension that calls it has
// no admin session. See routes/paSessionInstallRoutes.js.
const paSessionInstallRoutes = require("./routes/paSessionInstallRoutes");
```

**2. Just before `app.use(settingsRoutes);`** (i.e. ahead of the `enforce2fa` mounts):

```js
// One-click PlayerAuctions cookie hand-off. Gated by its own shared secret, not
// the admin session, so it is mounted here — ahead of the enforce2fa cascade —
// where the browser extension (which carries no admin session) can reach it.
// Off entirely until a secret is set (404 otherwise).
app.use(paSessionInstallRoutes);
```

**3. Set the secret** on the server (turns the route on; 404 until then):

```js
// one-off, from the repo root on the server
const s = require("./utils/settings");
const o = s.loadSettings();
o.playerauctionsInstallSecret = "<a long random string>";
s.saveSettings(o);
```

Then put the same base URL + secret into the extension's Settings panel.
