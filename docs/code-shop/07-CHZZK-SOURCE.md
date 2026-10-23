# Code shop — CHZZK codes as a second source (2026-10-23)

The CHZZK farm (`docs/CHZZK-FARM.md`) stores earned coupon codes encrypted in
`ChzzkReward` (`hasCode`, `codeEnc`, `codeEndAt` = use-by, `revealedAt`). From
this change on they enter the same ledger as SOOP codes and from there go
through the same planner, units, publish, expiry, reconcile and after-sale
paths. Nothing after ingest knows or cares which farm a code came from.

## Identity

| | SOOP | CHZZK |
| --- | --- | --- |
| `CodeStock.loginId` | the SOOP login id | `chzzk:<ChzzkAccount _id>` |
| `CodeStock.itemKey` | `SoopInventoryItem.key` | `r<rewardNo>` |
| `CodeStock.itemId` | inventory row id | `ChzzkReward._id` |
| `campaignIdx` / `groupKey` | `<dropsIdx>` / `<gameNo>:<dropsIdx>` | `chzzk-<campaignNo>` / `<gameNo>:chzzk-<campaignNo>` |
| `useBy` | `raw.useExpDate` | `codeEndAt` |

A SOOP login id holds no `:`, so the two can never collide; CHZZK groups and
slots never mix with SOOP ones, so no existing product picks a CHZZK code up.

## Games

`utils/codeShop/sources.js` `CHZZK_GAMES`: a game SOOP also farms keeps SOOP's
number (Overwatch `12`, Dokkaebi World `429`), so the existing per-game settings
and buyer guides apply. CHZZK-only games use `910001+` (`config.games` keys are
digits); an unknown category gets a stable `92xxxxx` number. `config.DEFAULTS.games`
lists 910001-910005 with `sell: false`: they show in Sales → Settings, unticked,
and nothing of theirs is drafted or sold until the owner ticks one (and checks
its marketplace game and how to redeem it).

## What reads the source

`utils/codeShop/sources.js` is the only file that knows both farms:

- `chzzkRows(deps)` — CHZZK stored codes as ingest rows (campaign already resolved).
- `encOf / encFor` — a row's ciphertext from either farm (units build, held
  release, after-sale replacement). Callers decrypt and check the ledger hash
  exactly as before.
- `soldLoginIds / isSoldLogin` — sold logins of both farms (a CHZZK login's buyer
  can read its coupons too): ingest holds, fill/views/after-sale skip, reconcile pulls.
- `chzzkReveals` — a code revealed in the CHZZK panel (`revealedAt`) is held like
  a SOOP reveal, and released from the Stock tab the same way.

A caller that passes its own `deps.models` without the CHZZK models simply has
no CHZZK source; the service passes all of them (`service.js MODEL_NAMES`).

## Rules that keep a code from being sold twice or too late

- **A sold CHZZK login is never deleted** (`chzzkFarm.deleteAccounts` keeps it
  and says so): its buyer can read its coupons on CHZZK, and the shop keeps its
  codes off sale only while the account row says `sold`. Unmarking sold first is
  the owner's explicit choice.
- **No known use-by, no sale:** a CHZZK code without `codeEndAt` is not read
  into the ledger (the expiry guard could never pull it), and the CHZZK
  collector never replaces a known `codeEndAt`/`earnedAt` with an empty one.
- A CHZZK reveal counts for 15 days (the window SOOP's reveal log has), so a
  code the owner released is not held again by an old reveal.

## Switch and failure

`config.sources.chzzk` (default `true`). `false` = ingest skips CHZZK rows;
rows already in the ledger stay where they are. A CHZZK **reward** read error
during ingest logs one warn event and the SOOP rows still go through. The sold
logins list is read fail-closed on purpose (a caller about to sell must never
take a sold login for an unsold one): if `ChzzkAccount` cannot be read, that
tick's ingest / fill / reconcile stop like any other database error. A stored
`config.sourceWords` list replaces the default one whole — if the owner ever
saves one, it must include `chzzk` and `naver`.

## Buyer text

`sourceWords` (config default and `textGuard.DEFAULT_SOURCE_WORDS`) add `chzzk`
and `naver`; non-ASCII text (Korean) is refused as before. A CHZZK reward with a
Korean name gets no default label, so its draft waits for the owner to name it.
The event is named by the CHZZK campaign's `startAt` (`eventDates.js`).

## CHZZK panel

`/api/chzzk/rewards` and `/api/chzzk/stock` say whether each code is in stock,
on sale or sold in the code shop (`shop`, `shopWord`, `onSale`, `sold`). The
panel asks before revealing a code the shop has on sale or sold.

## Tests

`tests/codeShopChzzk.test.js` (ingest identity/group/slot/use-by, sold and
revealed logins, the switch, a CHZZK failure, a unit built from CHZZK codes,
both-farm code reads and sold logins, held release, event date, the planner
drafting CHZZK Overwatch and not drafting an unticked CHZZK-only game).
