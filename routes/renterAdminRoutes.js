// Superadmin management of renters + the account-submission approval queue.
// Every route is requireSuperadmin. Approving a submission imports the renter's
// credentials into the account pool (tagged with their renterId) — the staging
// area the operator's device-auth + deploy tooling already works from. Nothing
// a renter does ever writes a live bot config.
const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const Renter = require("../models/Renter");
const RenterSubmission = require("../models/RenterSubmission");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const {
  createRenter,
  setPassword,
  sanitizeRenter,
} = require("../utils/renters");
const hosts = require("../utils/botHosts");
const { encrypt, decrypt } = require("../utils/secretBox");
const { stopConfigContainer, validFile } = require("./botConfigRoutes");

const router = express.Router();

// How many pool accounts belong to a renter (their quota "used").
function poolCount(renterId) {
  return AvailableAccount.countDocuments({ renterId: String(renterId) });
}

// Import a renter's parsed credentials into the account pool, tagged with their
// renterId. Skips any username already deployed on a bot or already in the pool
// (so an approve never double-assigns). Returns { added, skipped }.
async function importToPool(renter, parsed) {
  const clean = (parsed || [])
    .map((a) => ({
      username: String((a && a.username) || "").trim(),
      password: a && a.password != null ? String(a.password) : "",
      email: a && a.email ? String(a.email).trim() : "",
      clientSecret: a && a.clientSecret ? String(a.clientSecret).trim() : "",
    }))
    .filter((a) => a.username);
  if (!clean.length) return { added: 0, skipped: 0, toInsert: [] };

  const lowers = clean.map((a) => a.username.toLowerCase());
  const [inUseRows, existRows] = await Promise.all([
    BotAccount.find(
      { login: { $in: clean.map((a) => a.username) } },
      { login: 1 },
    ).lean(),
    AvailableAccount.find({ usernameLower: { $in: lowers } }, { usernameLower: 1 }).lean(),
  ]);
  const inUse = new Set(
    inUseRows.map((x) => String(x.login || "").trim().toLowerCase()),
  );
  const already = new Set(existRows.map((x) => x.usernameLower));

  const seen = new Set();
  const toInsert = [];
  let skipped = 0;
  for (const a of clean) {
    const lower = a.username.toLowerCase();
    if (seen.has(lower) || inUse.has(lower) || already.has(lower)) {
      skipped++;
      continue;
    }
    seen.add(lower);
    toInsert.push({
      _id: new mongoose.Types.ObjectId(),
      username: a.username,
      usernameLower: lower,
      password: a.password ? encrypt(a.password) : "",
      hasPassword: !!a.password,
      email: a.email ? encrypt(a.email) : "",
      clientSecret: a.clientSecret || "",
      status: "available",
      source: "renter",
      renterId: String(renter._id),
    });
  }
  return { added: toInsert.length, skipped, toInsert };
}

// Pending-account totals per renter, for the list view.
async function pendingByRenter() {
  const rows = await RenterSubmission.aggregate([
    { $match: { status: "pending" } },
    { $group: { _id: "$renter", batches: { $sum: 1 }, accounts: { $sum: "$count" } } },
  ]);
  const map = new Map();
  for (const r of rows)
    map.set(String(r._id), { batches: r.batches, accounts: r.accounts });
  return map;
}

// Validate + normalise a bot assignment. Empty = unassigned (allowed). Throws a
// friendly error for an unknown host, a bad file name, or a config already
// rented to someone else.
async function resolveAssignment(botHost, botFile, excludeRenterId) {
  botHost = String(botHost || "");
  botFile = String(botFile || "");
  if (!botFile) return { botHost: botHost || "", botFile: "" };
  if (!hosts.resolveHost(botHost)) throw new Error("Unknown host");
  if (!validFile(botFile)) throw new Error("Invalid config file");
  const clash = await Renter.findOne({ botHost, botFile });
  if (clash && String(clash._id) !== String(excludeRenterId || "")) {
    throw new Error(
      "That bot is already assigned to " + clash.username,
    );
  }
  return { botHost, botFile };
}

async function renterListView(r, pmap) {
  const used = await poolCount(r._id);
  const p = pmap.get(String(r._id)) || { batches: 0, accounts: 0 };
  return {
    ...sanitizeRenter(r),
    used,
    pendingBatches: p.batches,
    pendingAccounts: p.accounts,
  };
}

// LIST renters.
router.get("/renters", requireSuperadmin, async (req, res) => {
  try {
    const [renters, pmap] = await Promise.all([
      Renter.find({}).sort({ createdAt: -1 }).lean(),
      pendingByRenter(),
    ]);
    const out = await Promise.all(renters.map((r) => renterListView(r, pmap)));
    res.json({ success: true, renters: out });
  } catch (err) {
    console.error("renters list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Bot picker: every config file across hosts + who (if anyone) rents it.
router.get("/renters/bots", requireSuperadmin, async (req, res) => {
  try {
    const out = [];
    for (const meta of hosts.listHosts()) {
      const host = hosts.resolveHost(meta.id);
      let files = [];
      try {
        files = (await hosts.readdir(host)).filter((f) => validFile(f)).sort();
      } catch {
        files = [];
      }
      for (const file of files)
        out.push({ host: meta.id, hostLabel: meta.label, file });
    }
    const assigned = await Renter.find(
      { botFile: { $gt: "" } },
      { botHost: 1, botFile: 1, username: 1 },
    ).lean();
    const amap = new Map(
      assigned.map((a) => [a.botHost + "|" + a.botFile, a.username]),
    );
    out.forEach((o) => {
      o.assignedTo = amap.get(o.host + "|" + o.file) || null;
    });
    res.json({ success: true, bots: out });
  } catch (err) {
    console.error("renters bots error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// CREATE a renter.
router.post("/renters", requireSuperadmin, async (req, res) => {
  try {
    const b = req.body || {};
    const { botHost, botFile } = await resolveAssignment(b.botHost, b.botFile);
    const renter = await createRenter({
      username: b.username,
      password: b.password,
      displayName: b.displayName,
      botHost,
      botFile,
      maxAccounts: b.maxAccounts,
      accessStart: b.accessStart || null,
      accessEnd: b.accessEnd || null,
      notes: b.notes,
      createdBy: req.session.admin.id,
    });
    res.status(201).json({ success: true, renter: sanitizeRenter(renter) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET one renter + its submissions.
router.get("/renters/:id", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    const pmap = await pendingByRenter();
    const view = await renterListView(r, pmap);
    const submissions = await RenterSubmission.find(
      { renter: r._id },
      { accountsEnc: 0 },
    )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({
      success: true,
      renter: view,
      submissions: submissions.map((s) => ({
        id: String(s._id),
        status: s.status,
        count: s.count,
        added: s.added || 0,
        logins: s.logins || [],
        rejectReason: s.rejectReason || "",
        createdAt: s.createdAt,
        reviewedAt: s.reviewedAt || null,
      })),
    });
  } catch (err) {
    console.error("renter detail error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// UPDATE a renter (quota / lease / bot / name / notes).
router.put("/renters/:id", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    const b = req.body || {};
    if (b.botHost !== undefined || b.botFile !== undefined) {
      const { botHost, botFile } = await resolveAssignment(
        b.botHost !== undefined ? b.botHost : r.botHost,
        b.botFile !== undefined ? b.botFile : r.botFile,
        r._id,
      );
      r.botHost = botHost;
      r.botFile = botFile;
    }
    if (b.displayName !== undefined) r.displayName = String(b.displayName).slice(0, 80);
    if (b.notes !== undefined) r.notes = String(b.notes).slice(0, 500);
    if (b.maxAccounts !== undefined)
      r.maxAccounts = Math.max(0, Math.floor(Number(b.maxAccounts) || 0));
    if (b.accessStart !== undefined)
      r.accessStart = b.accessStart ? new Date(b.accessStart) : null;
    if (b.accessEnd !== undefined)
      r.accessEnd = b.accessEnd ? new Date(b.accessEnd) : null;
    await r.save();
    res.json({ success: true, renter: sanitizeRenter(r) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// RESET a renter's password.
router.post("/renters/:id/password", requireSuperadmin, async (req, res) => {
  try {
    await setPassword(req.params.id, (req.body || {}).password);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// SUSPEND — block access AND stop their bot.
router.post("/renters/:id/suspend", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    r.status = "suspended";
    let botStopped = false;
    if (r.botFile) {
      const host = hosts.resolveHost(r.botHost);
      if (host) {
        try {
          await stopConfigContainer(host, r.botFile);
          botStopped = true;
          r.botStoppedAt = new Date();
        } catch (e) {
          // Host offline / no container — access is still blocked; report it.
          console.error("suspend stop bot:", e.message);
        }
      }
    }
    await r.save();
    res.json({ success: true, renter: sanitizeRenter(r), botStopped });
  } catch (err) {
    console.error("renter suspend error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// UNSUSPEND — restore access. Does NOT auto-start the bot (operator starts it
// from the Bots page when ready).
router.post("/renters/:id/unsuspend", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findByIdAndUpdate(
      req.params.id,
      { $set: { status: "active", botStoppedAt: null } },
      { new: true },
    );
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, renter: sanitizeRenter(r) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE a renter (their config + accounts are left in place for the operator).
router.delete("/renters/:id", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    await RenterSubmission.deleteMany({ renter: r._id });
    res.json({ success: true });
  } catch (err) {
    console.error("renter delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Submission review queue
// ------------------------------------------------------------------

// LIST submissions (default: pending across all renters), with renter username.
router.get("/renter-submissions", requireSuperadmin, async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const q = ["pending", "approved", "rejected"].includes(status)
      ? { status }
      : {};
    const rows = await RenterSubmission.find(q, { accountsEnc: 0 })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("renter", "username botHost botFile")
      .lean();
    res.json({
      success: true,
      submissions: rows.map((s) => ({
        id: String(s._id),
        status: s.status,
        count: s.count,
        added: s.added || 0,
        logins: s.logins || [],
        rejectReason: s.rejectReason || "",
        renter: s.renter
          ? { id: String(s.renter._id), username: s.renter.username }
          : null,
        createdAt: s.createdAt,
        reviewedAt: s.reviewedAt || null,
      })),
    });
  } catch (err) {
    console.error("renter-submissions list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// APPROVE — decrypt the batch and import it into the account pool, tagged with
// the renter. This never touches a live bot; the operator then device-auths +
// deploys the pool accounts with the existing account-pool tooling.
router.post(
  "/renter-submissions/:id/approve",
  requireSuperadmin,
  async (req, res) => {
    try {
      const sub = await RenterSubmission.findById(req.params.id);
      if (!sub)
        return res.status(404).json({ success: false, message: "Not found" });
      if (sub.status !== "pending") {
        return res
          .status(409)
          .json({ success: false, message: "Already " + sub.status });
      }
      const renter = await Renter.findById(sub.renter);
      if (!renter) {
        return res
          .status(400)
          .json({ success: false, message: "Renter not found" });
      }
      let parsed;
      try {
        parsed = JSON.parse(decrypt(sub.accountsEnc) || "[]");
      } catch {
        return res
          .status(500)
          .json({ success: false, message: "Submission data is unreadable" });
      }
      const { added, skipped, toInsert } = await importToPool(renter, parsed);
      // Re-check the quota at approval time (the pool may have grown since submit).
      const used = await poolCount(renter._id);
      if (used + added > (Number(renter.maxAccounts) || 0)) {
        return res.status(400).json({
          success: false,
          message:
            "Approving would exceed the renter's limit (" +
            renter.maxAccounts +
            "); they already have " +
            used +
            " in the pool.",
        });
      }
      if (toInsert.length) {
        try {
          await AvailableAccount.insertMany(toInsert, { ordered: false });
        } catch (e) {
          // A concurrent insert of the same username can throw a dup-key error
          // even with ordered:false; the non-conflicting docs still land.
          if (!(e && e.code === 11000)) throw e;
        }
      }
      sub.status = "approved";
      sub.reviewedBy = req.session.admin.id;
      sub.reviewedAt = new Date();
      sub.added = added;
      sub.accountsEnc = ""; // credentials now live in the pool
      await sub.save();
      res.json({
        success: true,
        added,
        skipped,
        note:
          "Imported to the account pool (tagged to " +
          renter.username +
          "). Run them through device-auth, then deploy to their bot.",
      });
    } catch (err) {
      console.error("renter approve error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// REJECT — discard the batch (tokens wiped).
router.post(
  "/renter-submissions/:id/reject",
  requireSuperadmin,
  async (req, res) => {
    try {
      const sub = await RenterSubmission.findById(req.params.id);
      if (!sub)
        return res.status(404).json({ success: false, message: "Not found" });
      if (sub.status !== "pending") {
        return res
          .status(409)
          .json({ success: false, message: "Already " + sub.status });
      }
      sub.status = "rejected";
      sub.reviewedBy = req.session.admin.id;
      sub.reviewedAt = new Date();
      sub.rejectReason = String((req.body || {}).reason || "").slice(0, 300);
      sub.accountsEnc = "";
      await sub.save();
      res.json({ success: true });
    } catch (err) {
      console.error("renter reject error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
