// One-time repair: an account can farm drops for several games at once, but
// the old scan grouped ALL sellable drops under the bot's configured game —
// so a "Rainbow Six Siege" listing advertised Call of Duty / Delta Force
// drops, and a "Black Ops 7" set actually held Modern Warfare 4 items. The
// engine now lists ONE game per account (pickListingGroup). This fixes the
// sets created before that change and their live rows:
//   - multi-game set      -> keep the cover game's items only
//   - cover/name mismatch -> rename the set to the items' real game
//   - gameflip rows       -> delist + republish (no text-edit API)
//   - ggsel rows          -> update title/description in place
//   - digiseller rows     -> skipped with a note (no text-edit API)
//
//   node scripts/repair-mixed-game-sets.js            # dry run
//   node scripts/repair-mixed-game-sets.js --apply    # write
require("dotenv").config();
const mongoose = require("mongoose");
const settings = require("../utils/settings");
const mp = require("../utils/marketplaces");
const engine = require("../utils/unclaimedAutoList");
const { buildSetGridImage } = require("../utils/setImage");
const { decrypt } = require("../utils/secretBox");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const AvailableAccount = require("../models/AvailableAccount");
const WebBotAccount = require("../models/WebBotAccount");

const APPLY = process.argv.includes("--apply");
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drop shape publishGameflipUnit/listingTitle expect (like scan sellable).
function setItemsToDrops(items) {
  return (items || []).map((i) => ({
    name: i.name,
    game: i.game || "",
    campaign: i.campaign || "",
    imageURL: i.image || "",
    itemKey: i.itemKey || i.name,
  }));
}

async function unitCreds(ledger) {
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const pool = await AvailableAccount.findById(ledger.poolAccountId).lean();
    if (!pool) return null;
    let pw = "";
    try { pw = decrypt(pool.password || ""); } catch { pw = ""; }
    if (!pw) pw = engine.plainPassword(pool.credPasswordEnc);
    return { login: ledger.login || pool.login || "", password: pw, id: String(pool._id), poolAccountId: String(pool._id) };
  }
  if (ledger.source === "webbot" && ledger.webBotAccountId) {
    const wb = await WebBotAccount.findById(ledger.webBotAccountId).lean();
    if (!wb) return null;
    return {
      login: ledger.login || wb.login || "",
      password: engine.plainPassword(wb.credPasswordEnc),
      id: String(wb._id),
      webBotAccountId: String(wb._id),
    };
  }
  return null;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = { sets: 0, corrected: [], rows: 0, republished: 0, updated: 0, skipped: [], errors: [] };
  const log = (m) => console.log(m);

  // 1. Find broken unclaimed sets.
  const sets = await DropSet.find({ note: "Unclaimed auto-list" }).lean();
  const brokenSets = [];
  for (const s of sets) {
    const itemGames = Array.from(new Set((s.items || []).map((i) => norm(i.game)).filter(Boolean)));
    const cover = norm(s.coverGame);
    const single = itemGames.length === 1 ? itemGames[0] : "";
    if (itemGames.length > 1 || (single && cover && single !== cover)) {
      brokenSets.push(s);
    }
  }
  out.sets = brokenSets.length;
  log("broken sets: " + brokenSets.length);

  for (const set of brokenSets) {
    const itemGames = Array.from(new Set((set.items || []).map((i) => norm(i.game)).filter(Boolean)));
    const cover = norm(set.coverGame);
    const single = itemGames.length === 1 ? itemGames[0] : "";
    let newGame;
    if (single && cover && single !== cover) {
      newGame = set.items.find((i) => norm(i.game) === single).game; // real display name
    } else {
      // Multi-game: keep the cover game's items; fall back to the biggest group.
      const byGame = new Map();
      for (const i of set.items || []) {
        const k = norm(i.game);
        if (!k) continue;
        if (!byGame.has(k)) byGame.set(k, []);
        byGame.get(k).push(i);
      }
      const keepKey = cover && byGame.has(cover) ? cover : Array.from(byGame.entries()).sort((a, b) => b[1].length - a[1].length)[0][0];
      newGame = byGame.get(keepKey)[0].game;
    }
    const kept = (set.items || []).filter((i) => norm(i.game) === norm(newGame));
    log("\nSET " + set._id + " (" + (set.name || "").slice(0, 40) + ")");
    log("  cover: " + set.coverGame + " | item games: " + JSON.stringify(itemGames) + " -> " + newGame);
    log("  items: " + (set.items || []).length + " -> " + kept.length + " (" + kept.map((i) => i.name).join(", ").slice(0, 80) + ")");

    // Plan the row actions in dry run too (writes stay gated on APPLY).
    const rows = await MarketplaceListing.find({ origin: engine.ORIGIN, status: "active", set: set._id }).lean();
    for (const row of rows) {
      const title = engine.listingTitle(newGame, kept.map((i) => ({ name: i.name, game: newGame, campaign: i.campaign || "", imageURL: i.image || "", itemKey: i.itemKey || i.name })));
      const description = engine.listingDescription(newGame, kept.map((i) => ({ name: i.name, game: newGame, campaign: i.campaign || "", imageURL: i.image || "", itemKey: i.itemKey || i.name })));
      if (row.marketplace === "ggsel") log("  row ggsel " + row.externalId + ": would update text in place");
      else if (row.marketplace === "gameflip") log("  row gameflip " + row.externalId + " (" + row.accountLogin + "): would delist + republish");
      else if (row.marketplace === "digiseller") log("  row digiseller " + row.externalId + ": " + (String(row.description || "").includes("Game: " + newGame) ? "description ok — no change" : "SKIP (no text-edit API)"));
      else log("  row " + row.marketplace + " " + row.externalId + ": unhandled market");
    }

    if (!APPLY) continue;

    // 2. Correct the set.
    await DropSet.updateOne(
      { _id: set._id },
      {
        $set: {
          items: kept.map((i) => ({ ...i, game: newGame })),
          coverGame: newGame,
          name: newGame + " drops — unclaimed",
        },
      },
    ).catch((e) => out.errors.push("set " + set._id + ": " + e.message));
    out.corrected.push(String(set._id));

    // 3. Fix the ledger rows for the set (game label + listed-drops snapshot).
    const ledgers = await UnclaimedAccount.find({ set: set._id, status: "listed" }).lean();
    const dropSnap = kept.map((i) => ({ name: i.name, game: newGame, campaign: i.campaign || "", itemKey: i.itemKey || i.name }));
    for (const l of ledgers) {
      await UnclaimedAccount.updateOne(
        { _id: l._id },
        { $set: { game: newGame, drops: dropSnap } },
      ).catch(() => {});
    }
    log("  ledger rows updated: " + ledgers.length);

    // 4. Fix active rows for the set (use the CORRECTED set for image/row).
    const correctedSet = await DropSet.findById(set._id).lean();
    for (const row of rows) {
      out.rows++;
      const drops = setItemsToDrops(kept);
      const title = engine.listingTitle(newGame, drops);
      const description = engine.listingDescription(newGame, drops);
      if (row.marketplace === "ggsel") {
        log("  ggsel " + row.externalId + ": update text in place");
        if (APPLY) {
          try {
            await mp.ggselUpdateOffer(row.externalId, { title, description });
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { title, description } },
            );
            out.updated++;
            await sleep(1200);
          } catch (e) {
            out.errors.push("ggsel " + row.externalId + ": " + e.message.slice(0, 160));
          }
        }
      } else if (row.marketplace === "gameflip") {
        const ledger = await UnclaimedAccount.findOne({
          set: set._id,
          status: "listed",
          loginLower: String(row.accountLogin || "").toLowerCase(),
        }).lean();
        const cred = ledger ? await unitCreds(ledger) : null;
        if (!cred || !cred.password) {
          out.skipped.push("gameflip " + row.externalId + ": no credential for " + row.accountLogin);
          log("  gameflip " + row.externalId + ": SKIP (no credential for " + row.accountLogin + ")");
          continue;
        }
        log("  gameflip " + row.externalId + ": delist + republish with " + cred.login);
        if (APPLY) {
          try {
            // Delist first (no double-live window), then publish the corrected
            // listing with the same account as its live unit.
            await mp.gameflipDelist(row.externalId).catch(() => {});
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { status: "delisted", lastError: "repaired: mixed-game set re-listed with correct items" } },
            ).catch(() => {});
            let img = "";
            try { img = await buildSetGridImage(correctedSet); } catch { img = ""; }
            const cand = {
              source: ledger.source,
              id: cred.id || cred.poolAccountId || "",
              poolAccountId: cred.poolAccountId || "",
              login: cred.login,
              password: cred.password,
              game: newGame,
            };
            const nrow = await engine.publishGameflipUnit(correctedSet, cand, drops, Number(set.price) || 0, img);
            if (img) {
              const fsp = require("fs/promises");
              await fsp.unlink(img).catch(() => {});
            }
            await UnclaimedAccount.updateOne(
              { _id: ledger._id },
              {
                $set: {
                  listingIds: [String(nrow._id)],
                  listingExternalIds: [String(nrow.externalId)],
                  note: "unclaimed auto-list — live unit",
                },
              },
            ).catch(() => {});
            out.republished++;
            await sleep(1200);
          } catch (e) {
            out.errors.push("gameflip " + row.externalId + ": " + e.message.slice(0, 160));
          }
        }
      } else if (row.marketplace === "digiseller") {
        const cur = String(row.description || "");
        if (cur.includes("Game: " + newGame)) {
          log("  digiseller " + row.externalId + ": description already correct — no change");
        } else {
          out.skipped.push("digiseller " + row.externalId + ": needs republish (no text-edit API)");
          log("  digiseller " + row.externalId + ": SKIP (no text-edit API; description has wrong game)");
        }
      }
    }
  }

  console.log("\n--- SUMMARY ---");
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
