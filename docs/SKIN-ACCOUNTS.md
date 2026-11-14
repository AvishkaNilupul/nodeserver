# Skin Accounts

The superadmin page `/skin-accounts.html` manages a whole Rocket League Epic account and its linked Twitch account as one Eldorado account product. It is separate from fresh Epic stock and standalone Twitch drops. It does not publish farming services or enable other marketplaces.

## Workflow

1. Create an Epic account in the existing Epic Accounts page, then enroll an unused Epic/Twitch pair. Enrollment reserves both identities permanently. Historical purchases, rentals, copied credentials, other stock, duplicate Twitch identities and unavailable ownership evidence block enrollment.
2. Link the accounts through Epic Connections. Confirm their displayed external IDs in Skin Accounts. The server also checks Epic's authenticated external-auth identities against the numeric Twitch ID.
3. Inspect the game and record its full actual inventory, region, level, rank and credits. This records the initial Twitch count baseline. Later inventory confirmations must account for every pending claim; they do not reset the original pricing baseline.
4. Preview and publish with a real inventory image. Private instant delivery includes Epic and Twitch credentials and a 14-day Epic-only email-code viewer. Original mailboxes are excluded. The viewer's clock begins at sale.
5. Enable farming. The pair farms only Rocket League at one verified location until sale. Pausing a listing retains ownership and may continue farming. The separate Stop farming control disables it.

An existing one-unit Rocket League listing can be adopted after its exact private delivery, stock entry, mail session and account history are checked. Its actual photos, entry ID and custom marketplace attributes are preserved.

## Rewards and prices

The worker checks once per minute, sequentially. It confirms the exact Epic/Twitch link, stock ownership and live Twitch identity before updating anything. Only connected Rocket League `gameEventDrops` with awarded cumulative quantities enter the claim ledger. Campaign entitlement limits, unclaimed watch progress, legacy archive rows and unknown paint colours are not receipt evidence.

Verified game inventory and newly claimed Twitch rewards are separate public sections. Epic states that Fan Rewards enter the inventory on the next Rocket League login. There is no seller-accessible official cosmetic fulfillment API, so an automatically detected Twitch claim remains **awaiting game check** until an actual game inspection. A claim ledger survives Twitch archive disappearance without adding the same reward twice.

Growth pricing anchors the starting bundle price to the first verified inventory. Default configurable additions are $0.10 for a basic drop, $0.20 for a premium drop, $0.50 for a first cosmetic, $0.10 for cosmetic repeats, and $1.00 for an Apex Collection reward. These are configured additions, not claims of market value. Unknown reward types remain unpriced and are called out. A ceiling and reliable comparable whole-account offers bound increases; growth pricing never lowers the existing price. Manual and strict comparable-market modes are also available. Standalone Twitch listings are not comparable products.

## Integrity and recovery

- `SkinAccount` has lifetime unique Epic, bot, Twitch login and Twitch-ID ownership keys. Delisting, a refund or a failed operation never returns linked identities to ordinary stock.
- Epic selection/mutations and per-drop reservations share the Epic sales lock. The scanner applies a skin-product hold in the same upsert that records new drops. Ordinary per-game sales behavior is unchanged.
- A known sale is handled before further Epic/Twitch reads. Farming is disabled, its physical stop is attempted, and failed reload locations remain durable retry work. A host outage does not delay the buyer's paid mail access.
- Missing stock or conflicting identity stops farming and requires review. A read failure does not invent a sale or recreate an entry.
- Price-only updates use the stock-free price endpoint. Content edits pause the offer, re-read exact stock, preserve its existing entry ID and all private fields/photos, verify the result and only then resume an originally active offer. The observed Eldorado web-client contract provides no optimistic version condition; ambiguous edits stay paused.
- A publish intent is persisted before the remote create. A timeout/no-ID result is never retried and never matched by title. **Recover publish** verifies a specified existing offer against the exact prepared delivery, pauses it, and attaches it without creating stock. A wrong offer is not modified.
- Legacy Epic editors cannot rewrite skin-product delivery or credentials. The skin service owns those listings. Superadmin sessions, same-origin JSON mutations and no-store responses protect the page; credentials never appear in its API.

## Validation

Run `node --test tests/skinAccount*.test.js tests/skinAccountsPanel.test.js`. Tests cover the cumulative ledger, pricing, lifetime stock guards, auth/origin failures, physical farm moves/reload debts, sales during work, complete new-account publication, private delivery preservation, interrupted creates and recovery. Existing Epic sales and farm tests should be run when their integration points change. Live verification uses one owner-confirmed account pair; test accounts and simulated purchases must not be published.

References: [Epic Fan Rewards receipt behavior](https://www.epicgames.com/help/c-37599050/c-32343914/a19579807), [Twitch entitlement states and organization permissions](https://dev.twitch.tv/docs/api/reference/entitlements), [Twitch Drops integration](https://dev.twitch.tv/docs/drops/technical-guide). Marketplace attribute IDs were checked against Eldorado's live Rocket League Accounts metadata on 2026-11-14.
