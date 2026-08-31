// One-time live repair for the unclaimed auto-list system (run on the server):
//   1. Collapse duplicate active rows per (set, marketplace) — the v1 era
//      published 12 GGSel offers for one Overwatch set.
//   2. Scrub manual-sold accounts out of EVERY active row (they keep farming
//      but must never be auto-delivered).
//   3. Trim per-game listed ledgers down to GAME_CAP, with a fair share per
//      set so no listing is drained dry; the overflow is released for manual
//      sale (status "removed", listed tick cleared, still farming).
//
//   node scripts/repair-unclaimed-cap.js            # dry run (no writes)
//   node scripts/repair-unclaimed-cap.js --apply    # write
require("dotenv").config();
const mongoose = require("mongoose");
const settings = require("../utils/settings");
const mp = require("../utils/marketplaces");
const engine = require("../utils/unclaimedAutoList");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const AvailableAccount = require("../models/AvailableAccount");
const WebBotAccount = require("../models/WebBotAccount");

const APPLY = process.argv.includes("--apply");
const { GAME_CAP } = engine;

function ownerKey(l) {
  if (!l) return "";
  if (l.source === "noclaim" && l.poolAccountId) return "p:" + String(l.poolAccountId);
  if (l.source === "webbot" && l.webBotAccountId) return "w:" + String(l.webBotAccountId);
  return "";
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const out = { paused: false, deduped: 0, scrubbed: 0, released: 0, rebuilt: 0, delisted: 0, errors: [] };
  const log = (m) => console.log(m);

  if (APPLY) {
    const prev = !!settings.getAutoFarm().unclaimedAutoListPaused;
    settings.setAutoFarm({ unclaimedAutoListPaused: true });
    out.paused = prev;
    log("engine paused for repair");
  }

  try {
    const rows = await MarketplaceListing.find(
      { origin: "unclaimed", status: "active" },
    ).lean();
    const ledgers = await UnclaimedAccount.find({}, {}).lean();
    const msPool = new Set(
      (await AvailableAccount.find({ manualSold: true }, { _id: 1 }).lean()).map((x) => String(x._id)),
    );
    const msWeb = new Set(
      (await WebBotAccount.find({ manualSold: true }, { _id: 1 }).lean()).map((x) => String(x._id)),
    );
    const msKeys = new Set([...msPool].map((id) => "p:" + id));
    for (const id of msWeb) msKeys.add("w:" + id);

    // ---- 1. Collapse duplicate rows per set+marketplace --------------------
    const bySetMkt = new Map();
    for (const r of rows) {
      const k = String(r.set) + "|" + r.marketplace;
      if (!bySetMkt.has(k)) bySetMkt.set(k, []);
      bySetMkt.get(k).push(r);
    }
    const delistRow = async (row) => {
      try {
        if (row.marketplace === "gameflip") await mp.gameflipDelist(row.externalId);
        else if (row.marketplace === "digiseller") await mp.digisellerDelist(row.externalId);
        else if (row.marketplace === "ggsel") await mp.ggselDelist(row.externalId);
        if (APPLY) {
          await MarketplaceListing.updateOne(
            { _id: row._id, status: "active" },
            { $set: { status: "delisted", lastError: "dedupe collapse" } },
          ).catch(() => {});
        }
        return true;
      } catch (e) {
        out.errors.push("delist " + row.marketplace + " " + row.externalId + ": " + e.message);
        return false;
      }
    };
    for (const [k, rs] of bySetMkt) {
      if (rs.length < 2) continue;
      const keep = rs
        .slice()
        .sort(
          (a, b) =>
            (b.units || []).length - (a.units || []).length ||
            String(a.createdAt).localeCompare(String(b.createdAt)),
        )[0];
      for (const r of rs) {
        if (String(r._id) === String(keep._id)) continue;
        log("DEDUPE " + k + ": delist " + r.marketplace + " " + r.externalId + " (kept " + keep.externalId + ")");
        out.deduped++;
        if (APPLY) await delistRow(r);
      }
    }

    // ---- 2+3. Compute what must leave each row ----------------------------
    const liveLogins = new Set(
      rows
        .filter((r) => r.marketplace === "gameflip")
        .map((r) => String(r.accountLogin || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const listed = ledgers.filter((l) => l.status === "listed");
    const eligible = listed.filter((l) => !msKeys.has(ownerKey(l)));
    const manualLedgers = listed.filter((l) => msKeys.has(ownerKey(l)));

    // Per-game cap keep set (fair share per set).
    const keepByGame = new Map(); // gkey -> Set(loginLower)
    const gameGroups = new Map();
    for (const l of eligible) {
      const gk = engine.gameCapKey(l.game);
      if (!gk) continue;
      if (!gameGroups.has(gk)) gameGroups.set(gk, []);
      gameGroups.get(gk).push(l);
    }
    for (const [gk, arr] of gameGroups) {
      const keep = engine.allocateCapKeep(arr, GAME_CAP, liveLogins);
      keepByGame.set(gk, keep);
      const release = arr.filter((l) => !keep.has(l.loginLower)).map((l) => l.loginLower);
      if (release.length) {
        log("CAP " + gk + ": listed=" + arr.length + " keep=" + keep.size + " release=" + release.length);
        out.released += release.length;
      }
    }
    const releasedSet = new Set();
    for (const [gk, arr] of gameGroups) {
      const keep = keepByGame.get(gk);
      for (const l of arr) if (!keep.has(l.loginLower)) releasedSet.add(l.loginLower);
    }

    // Everything that must leave the rows: manual-sold logins (any status —
    // the v1 era left them on duplicate offers) + cap releases.
    const scrubLogins = new Set();
    for (const l of ledgers) {
      if (msKeys.has(ownerKey(l)) && l.loginLower) scrubLogins.add(l.loginLower);
    }
    const dropLogins = new Set([...scrubLogins, ...releasedSet]);

    // ---- 4. Rebuild each surviving row -------------------------------------
    for (const [k, rs] of bySetMkt) {
      const row = rs
        .slice()
        .sort(
          (a, b) =>
            (b.units || []).length - (a.units || []).length ||
            String(a.createdAt).localeCompare(String(b.createdAt)),
        )[0];
      const setMarketListed = listed.filter(
        (l) => String(l.set) === String(row.set) && l.market === row.marketplace,
      );
      const remaining = setMarketListed.filter((l) => !dropLogins.has(l.loginLower));
      const remainingSet = new Set(remaining.map((l) => l.loginLower));

      if (row.marketplace === "gameflip") {
        const live = String(row.accountLogin || "").toLowerCase();
        if (live && !remainingSet.has(live)) {
          const ledger = ledgers.find(
            (l) =>
              l.loginLower === live &&
              String(l.set) === String(row.set) &&
              l.market === "gameflip",
          );
          log("GF-LIVE " + k + ": live unit " + live + " must leave — delist + successor");
          if (APPLY && ledger) await engine.removeUnitFromRow(row, ledger, { log: false });
        }
        continue;
      }

      const rowUnits = row.units || [];
      const rowLogins = new Set(rowUnits.map((u) => String(u.login || "").toLowerCase()));
      const toDrop = rowUnits.filter((u) => dropLogins.has(String(u.login || "").toLowerCase()));
      const missing = remaining.filter((l) => !rowLogins.has(l.loginLower));

      if (!toDrop.length && !missing.length) continue;

      if (row.marketplace === "ggsel") {
        log("GGSEL " + k + " (" + row.externalId + "): drop=" + toDrop.length + " missing=" + missing.length + " -> " + remaining.length + " units");
        if (APPLY) {
          if (!remaining.length) {
            await mp.ggselDelist(row.externalId).catch((e) => out.errors.push("ggselDelist " + row.externalId + ": " + e.message));
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { status: "delisted", lastError: "cap trim — no stock" } },
            ).catch(() => {});
            out.delisted++;
          } else {
            await engine.rebuildGgselOffer(row, remaining.map((l) => ({ login: l.login })));
            out.rebuilt++;
          }
        }
      } else if (row.marketplace === "digiseller") {
        log("DIGI " + k + " (" + row.externalId + "): drop=" + toDrop.length + " missing=" + missing.length + " -> " + remaining.length + " units");
        if (APPLY) {
          for (const u of toDrop) {
            if (u.contentId) {
              await mp.digisellerRemoveContent(row.externalId, u.contentId).catch((e) =>
                out.errors.push("digisellerRemoveContent " + u.login + ": " + e.message),
              );
            }
          }
          if (!remaining.length) {
            await mp.digisellerDelist(row.externalId).catch(() => {});
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { status: "delisted", lastError: "cap trim — no stock" } },
            ).catch(() => {});
            out.delisted++;
          } else {
            // Rebuild the row's units from the units that are actually present
            // on the product. A "missing" ledger has no delivery code on the
            // product; fabricating a unit without one would create phantom
            // stock, so flag it for a manual add instead.
            const newUnits = rowUnits.filter((u) =>
              remainingSet.has(String(u.login || "").toLowerCase()),
            );
            if (missing.length) {
              out.errors.push(
                "digiseller " + row.externalId + ": " + missing.length +
                  " listed unit(s) missing from product — add manually: " +
                  missing.map((l) => l.loginLower).join(","),
              );
            }
            await MarketplaceListing.updateOne(
              { _id: row._id, status: "active" },
              { $set: { units: newUnits, accountLogin: newUnits.map((u) => u.login).join(", ") } },
            ).catch(() => {});
          }
        }
      }
    }

    // ---- 5. Park the dropped ledgers ---------------------------------------
    const parkLedger = async (l, note) => {
      log("PARK " + l.loginLower + " (" + (l.game || "?") + "/" + l.market + "): " + note);
      if (!APPLY) return;
      await UnclaimedAccount.updateOne(
        { _id: l._id, status: "listed" },
        { $set: { status: "removed", note, lastCheckedAt: new Date() } },
      ).catch(() => {});
      await engine.markOwnerUnlisted(l).catch(() => {});
    };
    for (const l of manualLedgers) {
      out.scrubbed++;
      await parkLedger(l, "manual sold — kept farming, removed from listings");
    }
    for (const l of eligible) {
      if (releasedSet.has(l.loginLower)) await parkLedger(l, "cap release (" + GAME_CAP + "/game) — kept unlisted for manual sale");
    }

    log("\n--- SUMMARY ---");
    log(JSON.stringify(out, null, 2));
  } finally {
    if (APPLY && !out.paused) {
      settings.setAutoFarm({ unclaimedAutoListPaused: false });
      log("engine resumed");
    }
    await mongoose.disconnect();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
