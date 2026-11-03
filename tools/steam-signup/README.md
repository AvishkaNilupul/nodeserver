# Local Steam account generator

Run `node tools/steam-signup/install-local.cjs` on macOS to install the login service, or run `node tools/steam-signup/local-app.cjs` in a terminal. Open http://127.0.0.1:4108 in the **Steam Testing** Chrome profile. No MongoDB, hosted-site login or production configuration is required.

Load `extension/steam-signup` through chrome://extensions and enable **Allow in Incognito** in its Details. The local page connects automatically after the extension is loaded. The extension is separate from the Marketplace Filler/Epic extension.

## Regional signups

Choose a country and optionally save a sample phone and fictional address. **Test selected proxy** checks the current exit without consuming an Outlook inbox. The picker includes the 115 country targets published for ProxyScrape Regular Residential; a target's presence in the picker does not guarantee an available exit. Each signup tests again.

Start signup performs these steps:

1. Check private-window access, close-other-private-windows prerequisites, and proxy control before allocating anything.
2. Read the current residential configuration from the central cloud pool through the private mail connection. Replace stale country, city, state, and sticky-session parameters for the requested country. Verify the server-side exit country.
3. Open an empty private window and apply the authenticated proxy with `incognito_session_only`, bypassing loopback addresses. Open the IP-check page in that window. Require the browser's observed IP and country to match the prepared sticky exit before reserving an inbox.
4. Atomically reserve an exclusively unused Steam inbox from the Outlook reader. Open Steam and fill both email fields and the country selector. The helper clicks the initial CAPTCHA checkbox, accepts the agreement authorized by Start, and clicks Continue once a real CAPTCHA response is present. Solve an image or puzzle challenge only if one appears.
5. Poll for a fresh Steam account-verification email in the same inbox. Open its verification link in a background tab of the same private window.
6. Fill the account-name and password form, dispatching Steam's normal password-validation keyboard event. Wait for Steam’s username and password availability checks, then click Done automatically. Only the created_account=1 success page saves a completed account. Close the assigned private window and clear its proxy settings after saving.

Resume keeps the original inbox, username, password, and requested country, and verifies a new matching-country proxy before reopening Steam. Close the interrupted private window first. A manually completed account must be recovered from its saved identity rather than starting another signup.

## One per country queue

Select countries in the regional queue, then Start regional queue. Select tested countries selects only targets whose last saved proxy check passed. Select all listed countries selects all published targets. The queue requires enough completely unused Outlook inboxes for the selected countries and creates one account per selected country, sequentially. It waits for the current signup to finish and close before opening the next. A proxy error, failed browser check, or mail allocation failure stops the queue. Stop after current finishes the current account and clears the rest. Reloading/closing the local page drops the queue; it never resumes silently.

## Account records

Saved accounts retain the requested country, browser-observed proxy country/IP/city/time, Steam signup country, and optional generated contact details. **Store country is a separate field and remains Unverified until checked in Steam.** Proxy geolocation and a signup selector are not proof of a finalized Steam Store country.

Sample phone numbers match their country's numbering format but are not SMS services. The address is explicitly fictional and includes the observed city when available. These fields are kept for local records and never submitted as real contact details to Steam. Save sample contact can add them to an existing saved account without overwriting existing contact data. Reveal clears credentials and contact details after one minute or when the page is hidden.

Accounts live in `~/Library/Application Support/SteamAccountGenerator/accounts.vault`, encrypted with AES-256-GCM. Back up it and `vault.key` together. Credentials and active proxy secrets are never logged or included in account-list responses. Proxy credentials are provided only to the configured proxy's authentication challenges for the assigned tabs. Normal Chrome windows keep their existing network settings.

The cloud Outlook pool must be reachable through its private SSH forward on 127.0.0.1:3999. It must report `authority: cloud` and `steam` in `/api/pool/capabilities` before the app allocates anything. Its `EXCLUSIVE_PURPOSES` set includes both Epic and Steam. Do not run a second reader against a copied usage file: the original server owns all reservations.

The local app requires a per-process token and Host/Origin checks for all account operations. Restarting it requires reconnecting the extension. The helper never solves image or puzzle challenges. It retries a CAPTCHA frame load at most twice with the same inbox, and stops on other visible Steam errors instead of submitting repeatedly. Starting a signup authorizes the displayed Steam agreement and account-creation steps. There is no marketplace publishing.

## Server upload

Finished accounts upload by themselves to the admin site's **Steam accounts** page (`/steam-accounts.html`), where games, store region and sale stage are managed. `cloud-sync.cjs` keeps a durable queue in the vault (Queued / Uploading / On server in the Server column, with Retry) and runs `cloud-import.cjs` on the server over `~/.ssh/claude_prod_deploy_ed25519`, with the account on stdin. The server only inserts; a repeat upload never overwrites anything edited there. Sample contact details and the proxy IP are not sent. Details: docs/STEAM-ACCOUNTS.md.

## Validation

Run `node --test tests/steamSignup.test.js tests/epicSignup.test.js`.

Coverage includes mailbox freshness/sender verification, local request authentication, concurrent allocation, browser-exit proof before allocation, resume without a second inbox, encrypted save and idempotent mail finalization, credential isolation, private-window prerequisites, country-target replacement/mismatch rejection, proxy credential scoping/retry limits, and Steam's inline keyup password validation.

The live browser test completed one regional signup through the private-window proxy, fresh Outlook verification link, account creation, encrypted save, mailbox finalization, and private-window cleanup. The tested proxy country list is stored locally in `proxy-region-test.json`; it contains no proxy credentials.

## Check store country

Each saved account has **Check store country** (then **Recheck store country**) in the Store country column. One check runs at a time. It signs in through a verified proxy in the signup country, reads Steam's explicit `wallet_country_code` using `UserAccount.GetClientWalletDetails#1`, saves the country and check time in the local encrypted vault, and signs out. Email Steam Guard codes are read automatically from that account's inbox. It does not start games or change the store country. A missing country stays Unverified; IP country and currency are never used as guesses. A failed recheck preserves the last successful result. Results remain local; existing server records are not overwritten.

Install the checker dependency with `npm ci --prefix tools/steam-signup` on a new Mac. The protocol adapter uses steam-user 5.3.0's transport with its bundled wallet protobuf; its request/response shape is covered by tests and pinned in the local lockfile. Protocol reference: https://github.com/SteamDatabase/Protobufs/blob/master/steam/steammessages_useraccount.steamclient.proto . Run `node --test tests/steamSignup.test.js tests/steamStoreCountry.test.js`.
