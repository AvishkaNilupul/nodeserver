# Z2U native automatic delivery

The integration uses Z2U's authenticated seller web endpoints, not an official API. It now includes durable session storage, a production stock adapter, single-dispatch imports, inventory reconciliation, offer protection and a monitoring CLI. Native automatic delivery is mandatory; there is no manual-delivery fallback.

The guarded one-unit production pilot has been activated and verified on the public storefront with instant delivery. Native account import/readback, paused preparation, sending-limit configuration, launch and the persistent protection worker have been exercised live. A completed paid automatic delivery and its populated success-receipt format still need verification. Normal monitoring does not refill, publish or resume offers. An explicit `run --launch-offer` startup option permits one guarded, durable one-unit launch.

## Components

| Component | Responsibility |
| --- | --- |
| `client.js`, `session.js` | Fixed-origin serialized requests, durable cookie jar, bounded failures and no automatic replay of writes |
| `privateStore.js` | Private atomic files and exclusive process locks |
| `vaultProtocol.js`, `offers.js` | Observed native storage and offer operations; exact listing snapshots and verified pause |
| `stock.js` | Exact adopted offer/set pairs, durable upstream reservation, live eligibility and confirmed-sale bookkeeping |
| `vaultLedger.js`, `vaultImport.js` | Durable upload intent, one dispatch and explicit source-to-product reconciliation |
| `vaultPrepare.js`, `dedicatedStorage.js` | Paused bootstrap for a verified newly created empty category before native auto-delivery can be enabled |
| `launch.js`, `workerLaunch.js` | Explicit one-unit activation inside the protected worker, with a durable non-replayable launch intent |
| `lifecycle.js` | Unsold/consumed/held classification; delivery requires independent verified success evidence |
| `engine.js`, `runtime.js` | Listing and source checks, expiry protection, monitoring and sanitized health output |
| `scripts/z2u-runtime.js` | Session import, one monitoring cycle, worker loop and bounded explicit stocking |
| `orderAudit.js`, `scripts/z2u-order-audit.js` | Historical-order collection and aggregate reporting |

Module paths are relative to `utils/z2u/` unless shown otherwise.

## Install and private state

Use Node.js 20.19 or newer and install the isolated runtime dependencies from the committed lockfile:

```sh
npm ci --prefix utils/z2u --omit=dev --ignore-scripts
node scripts/z2u-runtime.js --help
```

The runtime uses [tough-cookie](https://github.com/salesforce/tough-cookie/blob/master/README.md) for cookie parsing and matching, and [LinkeDOM](https://github.com/WebReflection/linkedom) for static HTML parsing. Their exact versions are pinned in `utils/z2u/package-lock.json`; the application dependency tree is not replaced.

Choose an absolute state directory outside this public repository, owned by the worker account with mode `0700`. Files must be private regular files, normally mode `0600`. Symlinked paths and shared/hard-linked files are refused. Keep cookie exports, session state, captures and real stock credentials out of source control and test fixtures.

| Private state | Contents |
| --- | --- |
| `config.json` | Explicitly adopted offers and complete expected public listing snapshots |
| `session.json` | Cookie jar, session generation and update time |
| `vault-ledger.json` | Source/product mappings and durable upload/delivery state; no credentials |
| `health.json` | Last check, last successful checks, adopted-config digests, protection results and structured alerts |
| `storage-provenance.json` | Verified fresh category-creation record required before the first preparation upload |
| `launch-intents/`, `launch-result.json` | Durable per-offer activation intent and the latest explicit launch result |
| `runtime.lock` and journal/session lock files | Local process ownership and recovery guards |

All CLI commands share the runtime lock. Stop the worker before session import, a separate check or explicit stocking. Lock recovery requires the recorded local process to be provably dead; elapsed time is not permission to take its lock. Malformed, foreign-host or ambiguous locks stay blocked. Do not delete locks or journals to force a retry. Only one host may own this integration's file journal; separate journals on separate hosts do not coordinate uploads.

## Authentication and configuration

Log in and unlock native Storage in the seller browser first. Privacy-password verification is a separate gate from ordinary login. Export only the Z2U browser cookies into a private JSON file. The importer accepts a cookie array with `name`, `value`, `domain`, `path` and the browser's security/session/expiry attributes; cookie values never belong in shell arguments or logs.

```sh
node scripts/z2u-runtime.js import-session \
  --state-dir /private/path/z2u \
  --source /private/path/z2u/browser-cookies.json
```

Session import verifies both seller-order and storage access before replacing the last good session. The transport persists subsequent `Set-Cookie` changes atomically and rejects a session replaced by another generation. Expired login, privacy lock and challenges are reported rather than bypassed. The runtime does not extract browser cookies or store the privacy password.

Start with a private `config.json` containing:

```json
{ "version": 1, "offers": [] }
```

A missing config also means no adopted offers. This intentionally produces `NO_ADOPTED_OFFERS`, not a healthy selling state.

Each adopted account offer needs these verified fields:

| Field | Meaning |
| --- | --- |
| `offerId` | Exact native offer being managed |
| `storageId` | Native storage category/container bound to that offer |
| `gameId`, `categoryId` | Exact native game and service category |
| `setId` | Exact production no-claim `DropSet` |
| `kind` | `account` for the current production source adapter |
| `maxPurchaseQuantity` | Verified positive integer maximum from the listing editor |
| `storageName` | Exact newly created category name, required for preparation |
| `deliveryNote` | Optional reviewed native delivery note for preparation |
| `expectedSnapshot` | Complete verified result of `protocol.readOfferSnapshot(...)`, including all observed form fields and listing status |

Native IDs in config are canonical positive decimal strings; `setId` is a canonical ObjectId string. Do not adopt by title or copy a partial snapshot: title, description, price, images, platform/category, purchase limits and every observed form field must match. Unknown fields or zero/unlimited purchase-limit semantics block readiness. The monitoring pass allows stock quantity and listing status to change while continuing to check the pinned contents; it never resumes a paused listing.

The source adapter receives `createZ2uStockAdapter({ ledger, adoptedOffers: config.offers })`. Its explicit offer/set pairs govern Z2U allocation. The legacy `gameMarketsFor` list controls only the old auto-list markets and cannot express Z2U; it is not a universal Rainbow Six prohibition. Existing explicit product restrictions, including the Overwatch restriction, remain enforced. Do not change global marketplace switches to adopt a Z2U offer.

## Monitor and stock

```sh
node scripts/z2u-runtime.js check --state-dir /private/path/z2u
node scripts/z2u-runtime.js run --state-dir /private/path/z2u
```

`check` runs one cycle; `run` repeats approximately every five minutes. These commands may pause an adopted offer to protect already committed stock. They also persist cookie and health state. Protection runs before the global storage-access check, so a storage-page change or privacy gate does not silently skip a pause attempt. A failed pause is reported as `pause_unverified`.

Health output separates access from offer readiness, reports empty storage and held reconciliation, and preserves the last successful times across failures. Alerts are JSON output and `health.json`; no external notification channel is wired. A one-cycle check exits `2` when unhealthy, `1` on command failure and `0` when healthy.

Explicit stocking requires the production database connection and current production allocator dependencies. With the worker stopped, use the exact adopted offer and a unique durable batch name:

```sh
node scripts/z2u-runtime.js stock \
  --state-dir /private/path/z2u \
  --offer "$Z2U_OFFER_ID" \
  --count 1 \
  --batch canary-unique-batch-name
```

The CLI accepts one to five accounts per call. `stocked` means every imported unit was uniquely verified in native storage; it does not publish or resume the offer. `held`, `partial`, `upload_uncertain` and other reconciliation states retain source ownership. Reuse the same batch name to inspect/reconcile an uncertain attempt. A new batch name requests a new allocation and must never be used to bypass an uncertain earlier upload.

Historical offers with different reward bundles cannot be adopted unchanged. Prepare the exact source set and matching paused offer before the first canary.

### First stock in a new native category

Z2U rejects enabling native automatic delivery while its category is empty. Use the separate preparation command for that initial stock:

```sh
node scripts/z2u-runtime.js prepare-stock \
  --state-dir /private/path/z2u \
  --offer "$Z2U_OFFER_ID" \
  --count 1 \
  --batch canary-unique-batch-name
```

The private `storage-provenance.json` must contain `version:1`, the exact offer/storage/game/category IDs, `name` and a canonical UTC `createdAt` from the verified category-creation record, no older than 24 hours. Native `create_t` has an unverified timezone and is not substituted for that record. The helper verifies account type, nonrepeatable/root-category settings, exact name and IDs, zero Stock/Used/Totals, empty complete inventory and every observed offer binding in the same game/service group. A dropdown option alone does not prove a dedicated category.

The complete desired offer snapshot must remain exactly paused (`statusCode:4`) throughout preparation. The initial delivery binding must be zero/unlinked or this dedicated category. Native disabled delivery is `is_auto_deliver=2`; enabled is `1`. The journal records a separate `preparationOnly` batch with automatic-delivery flags false. It persists intent, imports at most once, verifies the complete exact unused mapping, then configures native delivery after stock exists. Fresh settings, cutoff and paused-offer checks must pass before the journal becomes stocked. An acknowledgment cannot set the flags true.

A crash or incomplete result leaves the source held. Repeating the same preparation batch reconciles its existing attempt without another import; a category that now contains that attempt's stock is not required to prove empty again. Any unexpected activation triggers a containment pause. This workflow never publishes, manually delivers or releases stock.

### Explicit one-unit launch

After preparation returns verified `stocked`, start the dedicated worker with the explicit launch option:

```sh
node scripts/z2u-runtime.js run \
  --state-dir /private/path/z2u \
  --launch-offer "$Z2U_OFFER_ID"
```

This first performs a protection cycle, then verifies the worker's fresh persisted evidence, exact adoption/config digest, the existing source reservation and live credentials/expiry, the full paused listing, automatic-delivery settings and exactly one matching unused native product. It writes an exclusive durable activation intent before the native `on_line` request and verifies the public seller state afterward. An uncertain activation triggers deactivation and retains the intent and source hold.

The launch intent blocks another activation dispatch across crashes and restarts. Never remove it to force a retry. The worker remains running for protection after the attempt; ordinary subsequent monitoring does not refill or resume offers.

## Source and upload guarantees

`reserveExactBatch({ batchId, offerId, setId, count })` inserts a journaled Mongo batch anchor before invoking the current `noclaimStock` allocator. Repeated calls recover the same anchored rows; partial or crash-uncertain claims never allocate replacements. The file journal is additional dispatch protection, not a substitute for the cross-market allocator.

Only dedicated no-claim accounts with the exact finished reward set are eligible. Auto-farm and scoped sources are excluded. Before commitment, the Z2U allocator checks exact snapshot/live reward quantities and at least 24 hours of known remaining claim life. The adapter rechecks ownership, sold/connected state, duplicate logins and tokens, pool/ledger identities, renter/reseller leases, linked-account/archive commitments, other listings and the complete live inventory. Missing evidence holds the account. The verifier returned with the reservation binds the exact credential bytes prepared for upload and refuses a changed password.

Z2U uses a dedicated batch anchor and lifecycle. It is intentionally excluded from the legacy exported vault/publisher market lists, whose deletion and expiry logic assumes other platforms. A generic legacy MarketplaceListing is not the owner of these batches.

Import sequence:

1. Verify the adopted listing, upstream reservation and native delivery settings. Initial empty-category preparation uses the separate paused-only contract above.
2. Persist the batch and upload intent before sending credentials.
3. Dispatch at most once. An acknowledgment, timeout or process exit cannot authorize another send.
4. Read the complete scoped native inventory and match each unit uniquely by credentials, marker and storage/game/category ownership.
5. Mark stocked only when every matching product explicitly proves it is unused and current automatic-delivery settings still match.

The `storageId` in protocol/config is the category/container. The journal's per-unit `storageId` is the remote **product ID**. Never interchange them. Credentials stay in memory and the authenticated request, not in the journal, Mongo batch record, health output or logs.

## Delivery, expiry and holds

A consumed product is not proof of successful delivery. Native `used_time` is labeled “Out of stock time”; sold status, buyer reference, cancellation and disappearance are insufficient on their own. `lifecycle.reconcileProduct` marks delivered only after an independent verified success receipt matches the exact offer/product/storage/game/category and sale reference. The receipt identity is scoped per product so multi-unit orders remain distinct.

The CLI currently does not supply a populated native success-receipt parser. Consumption therefore remains `consumed_pending_confirmation` until that real receipt contract is verified and wired. Native automatic delivery can still operate; upstream sale finalization remains held. Once verified, the journal retains delivery and sale references, and repeated reconciliation safely projects the same sale into the source allocator after a crash. The source sale CAS also pins the exact batch owner. Existing delivered-source bookkeeping handles subsequent spending.

`readBatchState({ batchId, offerId })` supplies persisted expiry and held-source count without exposing credentials. For outstanding journaled stock, missing/unknown expiry, insufficient source holds, six hours or less remaining life, or offer/delivery drift triggers a verified pause attempt. Pausing does not delete vault products or release accounts. Expiry protection uses the latest verified claim-expiry metadata; it does not assume a live inventory refresh occurred on every monitoring cycle.

The production adapter exposes no release operation. The low-level journal accepts a release only from explicit complete, ownership-matched proof of an unsold deletion; it does not release upstream stock itself. Neither cancellation nor a paused offer, empty page, timeout or rollback is release evidence. Terminal source/product tombstones remain reserved against reuse.

## Protocol details

`GET /public/createToken` needs `X-Requested-With: XMLHttpRequest`; its token is the `__token__` response header. Without that header, HTTP 200 can contain no token. A response `url` is not a token.

Storage operations use `/Platform/userStorage/storageEntrance.html?entrance=...`; delivery settings use `/Sell/publicEntrance.html?type=getProDetail` and `submitDeliver`. Creation/import acknowledgment may omit object IDs, so readback establishes identity.

Import lines are `account|password|otherInfo|remark` or `code|otherInfo|remark`. The remote product calls buyer information `remark` and the internal marker `note`. Embedded separators/newlines are rejected because no escape contract was observed. Storage must have the expected type and nonrepeatable `is_repeat=2`.

Native automatic delivery requires `is_auto_deliver=1`, `outstock=1`, `is_agiso=0`, the exact storage category and a positive `buy_more` cutoff covering the verified listing maximum. `importReservedBatch` requires `maxPurchaseQuantity`; zero is not interpreted as unlimited. `deliveryReady` applies the same requirement before import and after readback. IDs reject arrays, objects, leading-zero strings and unsafe numeric values; large native IDs stay decimal strings.

The live configuration endpoint additionally requires the sending limit to exceed the listing's minimum purchase quantity. `buildDeliveryFields` therefore sends `buy_more=maxPurchaseQuantity+1`, rejecting integer overflow. For a min/max-one canary, the sending limit is 2 while the listing still permits only one unit per purchase. `configureNativeDelivery` returns the unchanged `maxPurchaseQuantity` and the separate `sendingLimit`. This is distinct from the storage category's 200-character delivery-note limit. A settings rejection after import is reconciled through the same persisted preparation batch; it must not cause another inventory upload.

## Deployment and rollback

Production is a deliberate mix of revisions. Fingerprint each existing target against its inspected production baseline; a branch name or repository HEAD does not prove parity. The shared changes are the current production `utils/noclaimStock.js`, `models/UnclaimedAccount.js` and `utils/marketClaimTags.js` plus the new dedicated modules and CLI. Do not replace unrelated production files with this branch's older versions.

Before deployment, run the focused suite, review the minimal diff from each production baseline, and back up only the intended overwritten files in a timestamped `_deploy_backup_<timestamp>/` directory. Copy the verified targets, install the isolated locked dependencies, re-fingerprint, and restart the relevant main application and dedicated worker processes when their loaded code/models changed. Verify the new process state, session access, protection checks and exact canary readback. Keep deployment times, private paths, live identities and rollback evidence in private project memory. Push the deployed code to the configured origin and refresh the applicable code index after committing.

Rollback begins by stopping the dedicated worker and verifying adopted offers are paused when required. Preserve native vault products, Mongo batch/source reservations and the private journal/launch intents. Do not restore an older journal, erase uncertain intents or return stock to a pool. Restore compatible code only from the targeted backup; keep Z2U enum/tag support while persisted Z2U rows depend on it. An existing native vault continues to hold credentials when its worker stops.

## Read-only historical audit

```sh
node scripts/z2u-order-audit.js --browser-script > /private/path/z2u-order-audit-browser.js
# Run the generated script in the signed-in seller tab; save its JSON privately.
node scripts/z2u-order-audit.js --input /private/path/z2u-order-audit.json
```

The collector follows discovered pages at a controlled pace, rejects repeated pages and session gates, and exports allowlisted order fields. The CLI emits aggregates without buyer identities or order identifiers. Completed gross is not payout; currencies stay separate and quantities are not inferred from prices. Exit status `2` means incomplete evidence.

## Verification

```sh
node --test tests/z2u[A-Z]*.test.js
```

This runs the dedicated rebuild suite; the historical `tests/z2u.test.js` belongs to the older application integration and requires the application dependency tree. Tests cover process races and crash recovery, paused empty-category preparation, non-replayable one-unit launch, uncertain imports, exact source ownership and bundle guards, complete readback, delivery evidence, session replacement, private-file protection, offer drift, expiry pausing and historical accounting. Live captures and real credentials are excluded from fixtures. The removed historical fulfiller must not be restored: it ignored multi-unit quantities, recorded deduplication after sending and released stock on ambiguous errors.
