# Rivals accounts

The admin page reads existing `rivalspreparations` holds. Publishing reuses
SteamListing, SteamSale and BuyerMailSession kind `steam`, including the existing
seven-day Steam Guard/email-change viewer, sale sync and order-fulfiller exclusion.
Original Outlook credentials are not delivered. Description and delivery note
state this explicitly. Linked Twitch reservations remain consumed permanently.

Only the local worker's completed, logged-out report can supply ownership proof.
Import checks exact preparation, Steam/Twitch pair, hold ID and complete expected
reward IDs. Private screenshots are hashed and served only through superadmin/2FA.

Publishing checks the real Steam-only inbox ledger and live mail reader, all
proof hashes, exact reserved pair, no other sales/listings/active booster, and
normal game sign-out. The preparation's durable publishing marker and conditional
Steam problem-to-listed reservation prevent duplicate publication across processes.
After a create request may have reached Eldorado, uncertain outcomes retain the
reservation and mail session for reconciliation; they never retry automatically.
Only failures before create release back to the original problem hold.

Rivals listings have kind `rivals`; normal Steam add-stock cannot mix in accounts
without matching costumes, description refresh retains the verified costume copy,
and delisting restores the internal problem hold rather than generic free stock.
One verified preparation is one offer/unit. Listing uses game227, Fresh Account/PC,
all seven original inventory proofs retained, up to five originals published
(Eldorado's screenshot limit), and no claim of ranked readiness or rank.

Seller access uses the main application's connector. A guarded operator CLI can
publish without touching its cookie jar: refresh blocked, Set-Cookie stripped,
settings writes refused. Never print delivery entries or credential responses.
The standard10% account fee estimate rounds up to a cent. Net excludes stock,
support and withdrawal costs. A draft price is not evidence of market demand.

## Listing presentation and reward history

Titles lead with verified costume names, then hero names that fit the160-character
limit. Repeated costume sets are grouped once in the description. Twitch inventory
is a separate claim-history audit; it cannot promote extra costumes to game-verified
stock. Received Chrono Tokens are included only with an original game claim receipt,
and are described as seasonal Battle Pass currency rather than a permanent balance.

`build-listing-images.cjs` makes a cropped overview and two full original contact
sheets plus the original claim receipt. It validates source hashes and compares the
visible decoded pixels at1:1 in every sheet. Original files remain untouched. This
layout currently expects1600x1035 source captures. No generated artwork is used.
`import-presentation.cjs` verifies profile/reward mapping, all image hashes and the
five-image/10MB limits before attaching metadata to the existing preparation.

The guarded operator `publish-eldorado.cjs --update ID` uploads images first, then
reads current stock, rebuilds entries using Steam's normal delivery flow, and
refuses any changed credential/session/note fingerprint. It preserves price and
existing entry IDs. If the unit sold before that read, it never puts it back.
The update audit stores old public offer fields and a stock hash, never passwords.
Any rollback must use current unsold entries, not the historical stock snapshot.
