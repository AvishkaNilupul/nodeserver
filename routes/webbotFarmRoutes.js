// ---------------------------------------------------------------------------
// Standalone WEB-TOKEN FARM test console.
//
// A separate, sandboxed system for testing the web-client-OAuth drop farmer
// (the `webbot-drops` project) — completely apart from the Android-token
// BotAccount rig, the auto-farmer, the scanner, listings and the Drop Archive.
//
//   * source of truth is the standalone `WebBotAccount` Mongo model — its own
//     collection, touched by nothing else on the site;
//   * the actual farming runs as the external `webbot-drops` manager process
//     (pointed at the same Mongo); this console SEEDS accounts, MONITORS the
//     status that process writes back, and can validate a token / read live
//     drops directly for a quick check;
//   * it is FARM-ONLY: web tokens can't clear Twitch's integrity gate to CLAIM,
//     so completed drops show as "ready · needs external claim" (claimBlocked).
//
// Superadmin-only. Nothing here creates listings or spends the shared pool.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const WebBotAccount = require("../models/WebBotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const settings = require("../utils/settings");
const { encrypt } = require("../utils/secretBox");
const webbotTwitch = require("../utils/webbotTwitch");

const router = express.Router();

const tail = (t) => (t ? String(t).slice(-6) : "");
const POOL_NOTE = "webbot-farm";

// Ready pool query — mirrors the auto-farmer / no-claim definition so all three
// agree on what "ready" means (verified token, available, not suspended). Here
// the pool's `clientSecret` becomes the WebBotAccount `webToken`.
function readyPoolQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
  };
}

// Safe DTO — never leaks the full web token or the stored password.
function toDTO(a) {
  return {
    id: String(a._id),
    login: a.login || "",
    twitchId: a.twitchId || "",
    tokenTail: tail(a.webToken),
    credUsername: a.credUsername || "",
    hasPassword: !!a.hasPassword,
    enabled: a.enabled !== false,
    lastStatus: a.lastStatus || "pending",
    lastStatusMessage: a.lastStatusMessage || "",
    currentGame: a.currentGame || "",
    currentChannel: a.currentChannel || "",
    currentMinutes: a.currentMinutes || 0,
    requiredMinutes: a.requiredMinutes || 0,
    totalMinutesWatched: a.totalMinutesWatched || 0,
    dropsClaimed: a.dropsClaimed || 0,
    claimBlocked: !!a.claimBlocked,
    dropsReadyUnclaimed: a.dropsReadyUnclaimed || 0,
    pinnedGame: a.pinnedGame || "",
    fromPool: !!a.fromPool,
    lastCheckedAt: a.lastCheckedAt || null,
    createdAt: a.createdAt || null,
  };
}

// ---------------------------------------------------------------------------
// Summary + all accounts (the collection is a test set, so return everything).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/state", requireSuperadmin, async (req, res) => {
  try {
    const rows = await WebBotAccount.find({}).sort({ updatedAt: -1 }).lean();
    const accounts = rows.map(toDTO);
    const byStatus = {};
    let enabled = 0;
    let totalMinutes = 0;
    let readyUnclaimed = 0;
    let claimBlocked = 0;
    for (const a of accounts) {
      byStatus[a.lastStatus] = (byStatus[a.lastStatus] || 0) + 1;
      if (a.enabled) enabled++;
      totalMinutes += a.totalMinutesWatched;
      readyUnclaimed += a.dropsReadyUnclaimed;
      if (a.claimBlocked) claimBlocked++;
    }
    res.json({
      success: true,
      summary: {
        total: accounts.length,
        enabled,
        farming: byStatus.ok || 0,
        dead: byStatus.dead || 0,
        totalMinutes,
        readyUnclaimed,
        claimBlocked,
        byStatus,
      },
      accounts,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Seed accounts from pasted "user:pass:token" / "user:token" / "token" lines.
// Dedupes by webToken; password (if present) is stored ENCRYPTED.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/seed", requireSuperadmin, async (req, res) => {
  try {
    const text = String(req.body.text || "");
    const lines = text.split(/\r?\n/);
    const created = [];
    const skipped = [];
    let duplicate = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      let user = "";
      let pass = "";
      let token = "";
      if (parts.length >= 3) {
        user = parts[0];
        pass = parts[1];
        token = parts[2];
      } else if (parts.length === 2) {
        user = parts[0];
        token = parts[1];
      } else {
        token = parts[0];
      }
      token = (token || "").trim();
      if (!token || token.length < 20) {
        skipped.push({ reason: "bad token", line: line.slice(0, 40) });
        continue;
      }
      const exists = await WebBotAccount.findOne({ webToken: token }).lean();
      if (exists) {
        duplicate++;
        continue;
      }
      await WebBotAccount.create({
        webToken: token,
        credUsername: user || "",
        credPasswordEnc: pass ? encrypt(pass) : "",
        hasPassword: !!pass,
        enabled: true,
        lastStatus: "pending",
      });
      created.push(tail(token));
    }
    res.json({ success: true, created: created.length, duplicate, skipped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pool availability (cheap count for the pull control).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/pool", requireSuperadmin, async (req, res) => {
  try {
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    const reserve = settings.getAutoFarm().poolReserve || 0;
    res.json({ success: true, ready, reserve, spendable: Math.max(0, ready - reserve) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pull N accounts from the shared pool into the web-token test set. Claims them
// (available -> claimed, with our note) so they can't be double-used by the
// auto-farmer, respecting the auto-farm reserve. The pool's clientSecret is
// stored as the WebBotAccount webToken; the (already-encrypted) password copies
// straight over. Deleting a pulled row releases the pool account again.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/pull", requireSuperadmin, async (req, res) => {
  const claimed = [];
  try {
    const count = Math.max(1, Math.min(200, parseInt(req.body.count, 10) || 0));
    if (!count) return res.status(400).json({ success: false, message: "Account count required." });

    // Never draw the shared pool below the auto-farm reserve.
    const reserve = settings.getAutoFarm().poolReserve || 0;
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    if (ready - count < reserve) {
      return res.status(409).json({
        success: false,
        message: `Only ${Math.max(0, ready - reserve)} account(s) spendable (${ready} ready, reserve ${reserve}). Lower the count.`,
      });
    }

    // Claim N atomically (available -> claimed) with our note so a later
    // release/delete can find them.
    for (let i = 0; i < count; i++) {
      const doc = await AvailableAccount.findOneAndUpdate(
        readyPoolQuery(),
        { $set: { status: "claimed", claimedAt: new Date(), claimedNote: POOL_NOTE } },
        { new: true, sort: { lastCheckAt: -1 } },
      );
      if (!doc) break;
      claimed.push(doc);
    }
    if (!claimed.length) {
      return res.status(409).json({ success: false, message: "No ready pool accounts to claim." });
    }

    let created = 0;
    let duplicate = 0;
    for (const a of claimed) {
      const token = a.clientSecret;
      const exists = await WebBotAccount.findOne({ webToken: token }).lean();
      if (exists) {
        // Already in the test set — hand this claim back rather than strand it.
        await AvailableAccount.updateOne(
          { _id: a._id },
          { $set: { status: "available", claimedAt: null, claimedNote: "" } },
        );
        duplicate++;
        continue;
      }
      await WebBotAccount.create({
        webToken: token,
        login: a.username || "",
        twitchId: a.twitchId || "",
        credUsername: a.username || "",
        credPasswordEnc: a.password || "", // already encrypted in the pool
        hasPassword: !!a.hasPassword,
        enabled: true,
        lastStatus: "pending",
        fromPool: true,
      });
      created++;
    }

    res.json({ success: true, created, duplicate, claimed: claimed.length });
  } catch (err) {
    // Roll the whole claim back so accounts aren't stranded out of the pool.
    if (claimed.length) {
      await AvailableAccount.updateMany(
        { _id: { $in: claimed.map((d) => d._id) } },
        { $set: { status: "available", claimedAt: null, claimedNote: "" } },
      ).catch(() => {});
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// Resolve :id → account doc or 404.
async function findAccount(req, res) {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{24}$/i.test(id)) {
    res.status(400).json({ success: false, message: "bad id" });
    return null;
  }
  const doc = await WebBotAccount.findById(id);
  if (!doc) {
    res.status(404).json({ success: false, message: "No such account." });
    return null;
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Validate one account's token directly (populates login + status without
// needing the farmer process running).
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/accounts/:id/validate", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    try {
      const who = await webbotTwitch.validateToken(doc.webToken);
      doc.login = who.login || doc.login;
      doc.twitchId = who.twitchId || doc.twitchId;
      doc.lastCheckedAt = new Date();
      doc.lastStatusMessage = `token valid · ${who.login}${who.expiresIn ? ` · expires_in ${who.expiresIn}s` : " · no expiry"}`;
      if (doc.lastStatus === "dead" || doc.lastStatus === "pending") doc.lastStatus = "idle";
      await doc.save();
      res.json({ success: true, account: toDTO(doc) });
    } catch (e) {
      if (e.code === "token_invalid") {
        doc.lastStatus = "dead";
        doc.lastStatusMessage = "token invalid";
        doc.lastCheckedAt = new Date();
        await doc.save();
        return res.json({ success: true, account: toDTO(doc) });
      }
      throw e;
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Live drop inventory for one account (direct web-token GQL read).
// ---------------------------------------------------------------------------
router.get("/api/webbot-farm/accounts/:id/drops", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    try {
      const inv = await webbotTwitch.fetchInventory(doc.webToken);
      res.json({ success: true, drops: inv.drops });
    } catch (e) {
      if (e.code === "token_invalid") {
        doc.lastStatus = "dead";
        doc.lastStatusMessage = "token invalid";
        doc.lastCheckedAt = new Date();
        await doc.save();
        return res.status(409).json({ success: false, message: "token invalid" });
      }
      throw e;
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Enable/disable, pin a game, clear the claim-blocked flag, delete.
// ---------------------------------------------------------------------------
router.post("/api/webbot-farm/accounts/:id/toggle", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    doc.enabled = !doc.enabled;
    await doc.save();
    res.json({ success: true, account: toDTO(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/api/webbot-farm/accounts/:id/pin", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    doc.pinnedGame = String(req.body.game || "").trim();
    await doc.save();
    res.json({ success: true, account: toDTO(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/api/webbot-farm/accounts/:id/clear-claimblock", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    doc.claimBlocked = false;
    doc.dropsReadyUnclaimed = 0;
    await doc.save();
    res.json({ success: true, account: toDTO(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/api/webbot-farm/accounts/:id", requireSuperadmin, async (req, res) => {
  try {
    const doc = await findAccount(req, res);
    if (!doc) return;
    // If this row was pulled from the pool, hand the account back so it isn't
    // stranded out of circulation.
    let released = false;
    if (doc.fromPool && doc.webToken) {
      const r = await AvailableAccount.updateOne(
        { clientSecret: doc.webToken, status: "claimed", claimedNote: POOL_NOTE },
        { $set: { status: "available", claimedAt: null, claimedNote: "" } },
      );
      released = (r.modifiedCount || 0) > 0;
    }
    await doc.deleteOne();
    res.json({ success: true, released });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
