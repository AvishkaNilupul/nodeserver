# Epic signup with Outlook

Load this directory as an unpacked extension in Chrome at `chrome://extensions`.
Reload it after an update. Version 1.3.0 adds proxy permissions; approve those
permissions and enable **Allow in Incognito** to use the proxy option.

The hosted panel needs `routes/epicSignupRoutes.js`, its mount in
`routes/epicAccountRoutes.js`, the Epic account/session models,
`utils/epicMailbox.js`, `utils/epicIdentityFactory.js`, `utils/epicNameCorpus.js`,
`public/epic-accounts.html`, and `public/epic-signup-panel.js`. Deploy by the
project's targeted-copy convention; preserve production drift.

On the Mac, `scripts/mail-dashboard.js` runs on 127.0.0.1:3999. It uses
`utils/epicMailOtp.js` and `utils/epicLocalProxy.js`. Proxy configuration is read
from the existing `~/epic-claim/.env` RES_HOST, RES_PORT, RES_USER and RES_PASS.
No Outlook token or proxy password is sent to the hosted panel.

Open `/epic-accounts.html`, select the proxy option if needed, and click
**Create Epic account**. Close existing private windows first. Chrome shares
proxy settings across its private session, so keep the signup window as the
only private window until it finishes. Regular browsing retains its proxy
settings. Complete the captcha and Continue action in the signup form.
Outlook verification and the authorization-code exchange then run automatically.

Each signup reserves one address under the `epic` purpose. SOOP usage does not
consume its Epic slot. Cancellation and errors preserve that reservation because
Epic may already have accepted the address. Reset only a specific confirmed
unused address in the local mail dashboard. Do not reset the pool in bulk.

Use **Resume latest signup** to reopen an interrupted attempt with the same address and credentials. The details form now waits for manual Continue without a five-minute timeout. Use **Cancel signup** from the same panel tab if an attempt stalls. Closing the
private signup window also stops its session. Signup passwords and final account
credentials are encrypted at rest. A signed-in account with a different email is
rejected before saving credentials.

Verification performed: reservation and cancellation tests; sender/time filtering;
expired and unauthorized sessions; wrong-account rejection; encrypted credentials;
private proxy scope and challenge ownership; live local-reader and residential
proxy connectivity. Live browser test created one Epic account through Outlook and the residential proxy. Email verification and subsequent recovery login succeeded. Epic then required its separate Store EULA. After owner-approved acceptance, the launcher token and encrypted account saved successfully; refreshing the token was independently verified. The encrypted test-account backup lives outside the repository in ~/epic-claim/test-accounts. This test used an isolated local database, not the production account fleet. The driver now detects current code-input fields and accounts.epicgames.com, sends EULA corrections through the official store review page, and waits for manual acceptance. Login recovery handles the separate password, authentication review, and optional console-link screens.
