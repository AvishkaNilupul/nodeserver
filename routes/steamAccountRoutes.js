// Steam accounts page API (/steam-accounts.html). Every route is superadmin;
// server.js mounts the router behind enforce2fa. Contract: docs/STEAM-ACCOUNTS.md.
//
// Rows are created only by tools/steam-signup/cloud-import.cjs (over SSH from
// the Mac). This router reads them, hands out credentials on an explicit
// request, and saves what the owner edits: games, region check, stage, notes.
const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const SteamAccount = require("../models/SteamAccount");
const SteamListing = require("../models/SteamListing");
const SteamG2gUnit = require("../models/SteamG2gUnit");
const SteamBoost = require("../models/SteamBoost");
const { nameOf } = require("../utils/steamBoostGames");
const { decrypt } = require("../utils/secretBox");

const router = express.Router();

const COUNTRY = /^[A-Z]{2}$/;
const STEAM_ID64 = /^7656119\d{10}$/;
const MAX_GAMES = 500;

function gameValue(games) {
  return Math.round((games || []).reduce((sum, g) => sum + (Number(g.priceUsd) || 0), 0) * 100) / 100;
}

// A row as the page sees it: never the password or email ciphertext.
function publicRow(a, boost = null) {
  const games = (a.games || []).map((g) => ({
    appId: g.appId ?? null,
    name: g.name,
    priceUsd: g.priceUsd || 0,
    addedAt: g.addedAt || null,
    verifiedAt: g.verifiedAt || null,
    playtimeMinutes: g.playtimeMinutes || 0,
  }));
  if (boost && a.stage === "boosting") {
    for (const id of boost.games || []) if ((boost.licensed || []).includes(id) && !games.some(g => g.appId === id)) games.push({ appId: id, name: nameOf(id), priceUsd: 0, addedAt: boost.createdAt, verifiedAt: boost.lastSeenAt, playtimeMinutes: Number(boost.minutes?.[id]) || 0 });
  }
  return {
    _id: String(a._id),
    accountName: a.accountName,
    signupCountry: a.signupCountry || null,
    requestedCountry: a.requestedCountry || null,
    proxyCountry: a.proxyCountry || null,
    proxyCity: a.proxyCity || "",
    storeCountry: a.storeCountry || null,
    steamId64: a.steamId64 || "",
    games,
    gameCount: games.length,
    valueUsd: gameValue(games),
    loaded: games.length > 0,
    stage: a.stage || "stock",
    notes: a.notes || "",
    soldAt: a.soldAt || null,
    soldNote: a.soldNote || "",
    boostedAt: a.boostedAt || null,
    preparationPurpose: boost?.purpose || null,
    source: a.source || "generator",
    signedUpAt: a.signedUpAt || null,
    importedAt: a.importedAt || a.createdAt || null,
    updatedAt: a.updatedAt || null,
  };
}

function summary(rows) {
  const out = { total: rows.length, empty: 0, loaded: 0, listed: 0, sold: 0, problem: 0, boosting: 0, availableEmpty: 0, preparing: 0, hourBoosting: 0, stockValueUsd: 0 };
  for (const r of rows) {
    if (r.stage === "sold") out.sold++;
    else if (r.stage === "listed") out.listed++;
    else if (r.stage === "problem") out.problem++;
    else if (r.stage === "boosting") out.boosting++;
    if (r.stage === "stock" && !r.loaded && !r.boostedAt) out.availableEmpty++;
    if (r.stage === "boosting") out[r.preparationPurpose === "game" ? "preparing" : "hourBoosting"]++;
    if (r.stage !== "sold" && r.stage !== "problem") {
      if (r.loaded) out.loaded++;
      else out.empty++;
      out.stockValueUsd += r.valueUsd;
    }
  }
  out.stockValueUsd = Math.round(out.stockValueUsd * 100) / 100;
  return out;
}

function safeDecrypt(value) {
  if (!value) return "";
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

function cleanGames(input) {
  if (!Array.isArray(input)) throw Error("games must be a list");
  if (input.length > MAX_GAMES) throw Error(`At most ${MAX_GAMES} games per account`);
  const seen = new Set();
  const games = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw Error("Each game needs a name");
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 160) throw Error("Each game needs a name of up to 160 characters");
    let appId = null;
    if (raw.appId !== null && raw.appId !== undefined && raw.appId !== "") {
      appId = Number(raw.appId);
      if (!Number.isInteger(appId) || appId < 0 || appId > 99999999) throw Error(`"${name}": the app ID must be a whole number`);
    }
    let priceUsd = 0;
    if (raw.priceUsd !== null && raw.priceUsd !== undefined && raw.priceUsd !== "") {
      priceUsd = Number(raw.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd < 0 || priceUsd > 10000) throw Error(`"${name}": the price must be between 0 and 10000`);
      priceUsd = Math.round(priceUsd * 100) / 100;
    }
    const key = appId !== null ? "app:" + appId : "name:" + name.toLowerCase();
    if (seen.has(key)) throw Error(`"${name}" is in the list twice`);
    seen.add(key);
    const addedAt = raw.addedAt && !Number.isNaN(Date.parse(raw.addedAt)) ? new Date(raw.addedAt) : new Date();
    games.push({ appId, name, priceUsd, addedAt });
  }
  return games;
}

// Build the $set for an edit. Only the listed fields can change here; login,
// password, email and the signup facts come from the Mac and stay as imported.
function buildUpdate(body, current) {
  const set = {};
  if ("storeCountry" in body) {
    const v = body.storeCountry;
    if (v === null || v === "") set.storeCountry = null;
    else if (typeof v === "string" && COUNTRY.test(v.toUpperCase())) set.storeCountry = v.toUpperCase();
    else throw Error("Store region must be a two-letter country code");
  }
  if ("steamId64" in body) {
    const v = typeof body.steamId64 === "string" ? body.steamId64.trim() : body.steamId64;
    if (v === null || v === "") set.steamId64 = "";
    else if (typeof v === "string" && STEAM_ID64.test(v)) set.steamId64 = v;
    else throw Error("Steam ID must be the 17-digit number that starts with 7656119");
  }
  if ("notes" in body) {
    if (typeof body.notes !== "string" || body.notes.length > 2000) throw Error("Notes can be up to 2000 characters");
    set.notes = body.notes;
  }
  if ("soldNote" in body) {
    if (typeof body.soldNote !== "string" || body.soldNote.length > 300) throw Error("Sale note can be up to 300 characters");
    set.soldNote = body.soldNote.trim();
  }
  if ("games" in body) set.games = cleanGames(body.games);
  if ("stage" in body) {
    if (!SteamAccount.STAGES.includes(body.stage)) throw Error("Unknown stage");
    set.stage = body.stage;
    if (body.stage === "sold" && current.stage !== "sold") set.soldAt = new Date();
    if (body.stage !== "sold") set.soldAt = null;
  }
  return set;
}

function validId(req, res) {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(400).json({ success: false, message: "Invalid account id" });
  return false;
}

router.get("/api/steam/accounts", requireSuperadmin, async (req, res) => {
  try {
    const docs = await SteamAccount.find({}, { password: 0, email: 0 }).sort({ signedUpAt: -1, createdAt: -1 }).lean();
    const boosts = await SteamBoost.find({ steamAccountId: { $in: docs.filter(a => a.stage === "boosting").map(a => a._id) }, state: { $in: ["queued", "boosting", "stopping"] } }).select("steamAccountId games licensed minutes purpose createdAt lastSeenAt").lean();
    const byAccount = new Map(boosts.map(b => [String(b.steamAccountId), b]));
    const accounts = docs.map(a => publicRow(a, byAccount.get(String(a._id))));
    res.json({ success: true, accounts, summary: summary(accounts) });
  } catch (err) {
    console.error("[steam-accounts] list failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load Steam accounts" });
  }
});

router.get("/api/steam/accounts/:id/credentials", requireSuperadmin, async (req, res) => {
  if (!validId(req, res)) return;
  res.set("Cache-Control", "no-store");
  try {
    const a = await SteamAccount.findById(req.params.id, { accountName: 1, password: 1, email: 1 }).lean();
    if (!a) return res.status(404).json({ success: false, message: "Account not found" });
    const password = safeDecrypt(a.password);
    const email = safeDecrypt(a.email);
    if (password === null || email === null) {
      return res.status(500).json({ success: false, message: "Saved login could not be decrypted" });
    }
    res.json({ success: true, accountName: a.accountName, password, email });
  } catch (err) {
    console.error("[steam-accounts] credentials failed:", err.message);
    res.status(500).json({ success: false, message: "Could not read the login" });
  }
});

router.patch("/api/steam/accounts/:id", requireSuperadmin, async (req, res) => {
  if (!validId(req, res)) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const current = await SteamAccount.findById(req.params.id, { stage: 1 }).lean();
    if (!current) return res.status(404).json({ success: false, message: "Account not found" });
    let set;
    try {
      set = buildUpdate(body, current);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }
    // An account on a live Eldorado listing is the sale engine's
    // (utils/steamSales.js): a hand edit of its stage could put it on sale
    // twice or hide a sale. Remove it from the listing first.
    if ("stage" in set && set.stage !== current.stage) {
      const onListing = await SteamListing.exists({
        status: { $ne: "removed" },
        accounts: { $elemMatch: { steamAccountId: current._id, state: "listed" } },
      });
      if (onListing) {
        return res.status(409).json({
          success: false,
          message: "This account is on sale on Eldorado. Remove it from its listing (Selling on Eldorado) before changing its stage.",
        });
      }
      // Or sitting in a G2G offer's stock (utils/steamG2g.js).
      if (await SteamG2gUnit.exists({ steamAccountId: current._id, state: { $in: ["loading", "listed"] } })) {
        return res.status(409).json({
          success: false,
          message: "This account is in a G2G offer's stock. Remove it on G2G first; its stage can't change by hand while it's there.",
        });
      }
      // Or in the hour-boost pool (utils/steamBoost.js): the worker is logged in to it.
      if (current.stage === "boosting" || set.stage === "boosting" || (await SteamBoost.exists({ steamAccountId: current._id, state: { $in: ["queued", "boosting"] } }))) {
        return res.status(409).json({
          success: false,
          message: "Boosting is set on the Hour boost tab: stop the boost there first; the stage can't change by hand while it runs.",
        });
      }
    }
    if (!Object.keys(set).length) return res.status(400).json({ success: false, message: "Nothing to save" });
    const saved = await SteamAccount.findOneAndUpdate(
      { _id: req.params.id, stage: current.stage },
      { $set: set },
      { returnDocument: "after", runValidators: true, projection: { password: 0, email: 0 } },
    ).lean();
    if (!saved) return res.status(409).json({ success: false, message: "The account changed while saving. Reload it and try again." });
    res.json({ success: true, account: publicRow(saved) });
  } catch (err) {
    console.error("[steam-accounts] save failed:", err.message);
    res.status(500).json({ success: false, message: "Could not save the account" });
  }
});

module.exports = router;
module.exports._internal = { publicRow, summary, cleanGames, buildUpdate };
