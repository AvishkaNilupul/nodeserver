# Valorant account creator

Run `node tools/valorant-signup/local-app.cjs` and open <http://127.0.0.1:4110/> in the dedicated testing Chrome profile. On macOS, `node tools/valorant-signup/install-local.cjs` installs the login service. Load `extension/valorant-signup` unpacked and enable **Allow in Incognito**. Connect it from the local page.

The creator shares the existing cloud Outlook tunnel on loopback 3999 and the existing regional residential proxy preparation. The authoritative pool must advertise `riot` in `exclusivePurposes`. It fails before allocating if that guarantee is absent. Do not start a local mail-dashboard writer. Every Riot inbox is completely unused before reservation and stays exclusive after an interruption or failure.

Choose a country or several countries for a sequential queue, then Start. Each signup verifies the server exit and the private browser exit before reserving mail. The normal Riot signup form receives a generated username, strong password, adult birth date and assigned email. Its current flow can ask for a six-digit email verification before credentials; the helper reads that code from the assigned inbox. Required agreements are authorized by Start; marketing stays off. Riot handles its challenge normally. Complete visual challenges in its window if shown. The helper fills each step; click Riot’s forward control and final Accept directly. It keeps the same form available without repeated submissions. Resume retains the same identity and country.

The current official entry is `https://xsso.playvalorant.com/login?uri=https%3A%2F%2Fplayvalorant.com%2Fen-us%2Fplatform-selection%2F&prompt=signup&show_region=true&locale=en_US`; it redirects through Riot authentication. Old `signup.playvalorant.com` and `signup.riotgames.com` hosts did not resolve on 2026-11-04.

The page-world observer watches only Riot's `/api/v1/login` signup/verification response. Completion requires a successful signup receipt for the assigned username, or successful verification after that signup. Generic login success, filled forms and HTTP 200 cannot complete an account. The observer forwards no password, session cookie or token. Saved credentials use the existing AES-256-GCM local vault under `~/Library/Application Support/ValorantAccountGenerator`, outside Git. Back up `accounts.vault` and `vault.key` together.

The signup country, verified proxy country, expected shard, actual residence country and actual shard are separate. Country and shard remain unverified after signup. No market listing, progression, game client, level or ranked readiness is inferred or changed. Fresh Riot accounts need a separate game-region/progression verification step before they become sale stock. Korea, China and other country-specific identity flows are outside this initial picker.

Reference seller: [TAceOfSpades](https://www.eldorado.gg/users/TAceOfSpades/shop/Account), 17 public Valorant offers checked 2026-11-04. AP, NA, EU, LATAM and Turkey; levels 10–19 advertised with ranked locked, levels 20–30 and 50–70 advertised as ranked ready. A fresh creator is the input to that product pipeline.

Checks: `node --test tests/valorantSignup.test.js`. Live browser creation must be reported separately from these fixture checks.
