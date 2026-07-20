// Superadmin management of renters + the account-submission approval queue.
// Every route is requireSuperadmin. The operator reveals a submission's
// credentials, fetches the device-auth tokens themselves, adds the accounts to
// the renter's bot with the existing tools, then Approves — which marks the
// batch approved and starts the renter's bot. Nothing here is driven by renter
// input, and renter-submitted credentials are only ever revealed to a superadmin.
const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const Renter = require("../models/Renter");
const RenterSubmission = require("../models/RenterSubmission");
const RenterAccount = require("../models/RenterAccount");
const RenterDrop = require("../models/RenterDrop");
const {
  createRenter,
  setPassword,
  sanitizeRenter,
  revealPassword,
} = require("../utils/renters");
const hosts = require("../utils/botHosts");
const { decrypt } = require("../utils/secretBox");
const {
  startConfigContainer,
  stopConfigContainer,
  restartConfigContainer,
  containerForFile,
  validFile,
  parseAccounts,
  dedupeAccounts,
  addRenterAccountsToConfig,
  provisionEmptyConfig,
  getConfigGames,
} = require("./botConfigRoutes");

const router = express.Router();

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
  const used = await RenterAccount.countDocuments({ renter: r._id });
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

// LIST every RENTED bot with live status — the "Rented bots" overview in the
// Renting section (an operator-wide view of the fleet, so a bot doesn't have to
// be opened renter-by-renter). Account/drop counts come from the standalone
// renter inventory; running state from one dockerPs per host (cached, so hosts
// aren't probed once per bot).
router.get("/renter-bots", requireSuperadmin, async (req, res) => {
  try {
    const renters = await Renter.find({ botFile: { $gt: "" } })
      .sort({ createdAt: -1 })
      .lean();
    const ids = renters.map((r) => r._id);
    const [accAgg, dropAgg] = await Promise.all([
      RenterAccount.aggregate([
        { $match: { renter: { $in: ids } } },
        { $group: { _id: "$renter", n: { $sum: 1 } } },
      ]),
      RenterDrop.aggregate([
        { $match: { renter: { $in: ids } } },
        { $group: { _id: "$renter", n: { $sum: 1 } } },
      ]),
    ]);
    const accMap = new Map(accAgg.map((a) => [String(a._id), a.n]));
    const dropMap = new Map(dropAgg.map((a) => [String(a._id), a.n]));

    // One dockerPs per host, reused across every bot on that host.
    const psCache = new Map();
    async function getPs(host) {
      if (psCache.has(host.id)) return psCache.get(host.id);
      let states = null;
      try {
        states = await hosts.dockerPs(host);
      } catch {
        states = null; // host offline / unreachable
      }
      psCache.set(host.id, states);
      return states;
    }

    const bots = [];
    for (const r of renters) {
      const host = hosts.resolveHost(r.botHost);
      let running = null;
      let online = false;
      let hostLabel = r.botHost;
      if (host) {
        hostLabel = host.label;
        const states = await getPs(host);
        if (states) {
          online = true;
          const st = states[containerForFile(r.botFile)];
          running = !!(st && /^running/i.test(st.state || ""));
        }
      }
      bots.push({
        renterId: String(r._id),
        username: r.username,
        status: r.status,
        host: r.botHost,
        hostLabel,
        file: r.botFile,
        container: containerForFile(r.botFile),
        online,
        running,
        accounts: accMap.get(String(r._id)) || 0,
        drops: dropMap.get(String(r._id)) || 0,
      });
    }
    res.json({ success: true, bots });
  } catch (err) {
    console.error("renter-bots list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// RENTED DROPS ARCHIVE — the operator's view of everything the renter bots have
// farmed, aggregated from the standalone RenterDrop inventory (never the
// operator's own DropLog / Drops Archive). Grouped by reward (itemKey) with a
// total; optional ?renter=<id> narrows it to one renter. Also returns a per-
// renter roster (with drop totals) so the UI can offer a filter dropdown.
router.get("/renter-drops", requireSuperadmin, async (req, res) => {
  try {
    const rid = req.query.renter;
    const match = {};
    if (rid && rid !== "all" && mongoose.isValidObjectId(rid)) {
      match.renter = new mongoose.Types.ObjectId(rid);
    }
    const rows = await RenterDrop.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$itemKey",
          name: { $first: "$name" },
          game: { $first: "$game" },
          image: { $first: "$imageLocal" },
          imageURL: { $first: "$imageURL" },
          count: { $sum: "$count" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 1000 },
    ]);
    const items = rows.map((d) => ({
      name: d.name || "Reward",
      game: d.game || "",
      image: d.image || d.imageURL || "",
      count: d.count || 0,
    }));
    const total = items.reduce((s, d) => s + d.count, 0);

    // Per-renter drop totals (for the filter dropdown), joined to usernames.
    const perRenter = await RenterDrop.aggregate([
      { $group: { _id: "$renter", drops: { $sum: "$count" } } },
    ]);
    const names = new Map(
      (
        await Renter.find(
          { _id: { $in: perRenter.map((p) => p._id) } },
          { username: 1 },
        ).lean()
      ).map((r) => [String(r._id), r.username]),
    );
    const renters = perRenter
      .map((p) => ({
        id: String(p._id),
        username: names.get(String(p._id)) || "(unknown)",
        drops: p.drops || 0,
      }))
      .sort((a, b) => b.drops - a.drops);

    res.json({ success: true, total, items, renters });
  } catch (err) {
    console.error("renter-drops archive error:", err.message);
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
    const bot = await renterBotStatus(r);
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
      bot,
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

// RESET a renter's password (superadmin only). Renters cannot change it.
router.post("/renters/:id/password", requireSuperadmin, async (req, res) => {
  try {
    await setPassword(req.params.id, (req.body || {}).password);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// REVEAL a renter's password (superadmin only). Returns "" for renters created
// before viewable passwords existed — reset it to make it viewable.
router.get("/renters/:id/password", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, password: revealPassword(r) });
  } catch (err) {
    console.error("renter reveal password error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
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
// from the Renting section when ready).
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

// CREATE a fresh, empty bot for a renter — provisioned entirely within the
// Renting section (not borrowed from the operator's Bots page). Allocates the
// next config slot on the chosen host, clones a template's settings with NO
// accounts, and registers the compose service. The bot is left stopped; it
// starts on the first approved submission (an empty bot must never be started —
// see startConfigContainer's no-accounts guard). One bot per renter: refuses if
// they already have one assigned.
router.post("/renters/:id/create-bot", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    if (r.botFile) {
      return res.status(409).json({
        success: false,
        message: "This renter already has a bot (" + r.botFile + ").",
      });
    }
    const host = hosts.resolveHost((req.body && req.body.host) || "local");
    if (!host) {
      return res.status(400).json({ success: false, message: "Unknown host" });
    }
    let slot;
    try {
      slot = await provisionEmptyConfig(host);
    } catch (e) {
      return res.status(e.unreachable ? 502 : 500).json({
        success: false,
        offline: !!e.unreachable,
        message: e.message || "Could not create the bot",
      });
    }
    r.botHost = host.id;
    r.botFile = slot.file;
    r.botStoppedAt = null;
    await r.save();
    res.status(201).json({
      success: true,
      renter: sanitizeRenter(r),
      bot: {
        assigned: true,
        running: false,
        accounts: 0,
        hostLabel: host.label,
        file: slot.file,
      },
    });
  } catch (err) {
    console.error("renter create-bot error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Renter bot — status + control from the Renting section (so the operator
// manages a renter's bot here, not mixed into their own Bots page).
// ------------------------------------------------------------------
async function renterBotStatus(renter) {
  // Account count is the renter's own inventory (correct even if the host is
  // offline), independent of the live config on the host.
  const accounts = await RenterAccount.countDocuments({ renter: renter._id });
  if (!renter.botFile) return { assigned: false, running: null, accounts };
  const host = hosts.resolveHost(renter.botHost);
  if (!host)
    return { assigned: true, running: null, accounts, host: renter.botHost };
  let running = null;
  try {
    const states = await hosts.dockerPs(host);
    const st = states[containerForFile(renter.botFile)];
    running = !!(st && /^running/i.test(st.state || ""));
  } catch {
    running = null;
  }
  return {
    assigned: true,
    running,
    accounts,
    hostLabel: host.label,
    file: renter.botFile,
  };
}

router.get("/renters/:id/bot", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, bot: await renterBotStatus(r) });
  } catch (err) {
    console.error("renter bot status error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Start / stop / restart a renter's bot (operator). Target is always the
// renter's own assigned config — never anything from the request body.
router.post("/renters/:id/bot/:action", requireSuperadmin, async (req, res) => {
  const action = req.params.action;
  if (!["start", "stop", "restart"].includes(action)) {
    return res.status(400).json({ success: false, message: "Unknown action" });
  }
  try {
    const r = await Renter.findById(req.params.id);
    if (!r || !r.botFile) {
      return res
        .status(400)
        .json({ success: false, message: "Renter has no bot assigned" });
    }
    const host = hosts.resolveHost(r.botHost);
    if (!host) {
      return res
        .status(400)
        .json({ success: false, message: "Renter's host is unknown" });
    }
    if (action === "start") {
      await startConfigContainer(host, r.botFile);
      r.botStoppedAt = null;
      await r.save();
    } else if (action === "stop") {
      await stopConfigContainer(host, r.botFile);
      r.botStoppedAt = new Date();
      await r.save();
    } else {
      await restartConfigContainer(host, r.botFile);
    }
    res.json({ success: true, running: action !== "stop" });
  } catch (e) {
    const msg =
      e.code === "no_accounts"
        ? "The bot has no accounts yet — add some first."
        : e.code === "disabled"
          ? "Bot control is disabled on this server."
          : e.unreachable
            ? "The bot host is offline right now."
            : e.message || "Could not " + action + " the bot.";
    const status = e.unreachable ? 502 : e.code ? 400 : 500;
    if (!e.code && !e.unreachable) {
      console.error("renter bot " + action + " error:", e.message);
    }
    res.status(status).json({ success: false, message: msg });
  }
});

// DELETE a renter (their config + accounts are left in place for the operator).
router.delete("/renters/:id", requireSuperadmin, async (req, res) => {
  try {
    const r = await Renter.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    // Tear down the renter's standalone inventory too (their tenant boundary).
    // The bot config file itself is left on the host for the operator to reuse.
    await Promise.all([
      RenterSubmission.deleteMany({ renter: r._id }),
      RenterAccount.deleteMany({ renter: r._id }),
      RenterDrop.deleteMany({ renter: r._id }),
    ]);
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

// REVEAL a submission's credentials so the operator can fetch the device-auth
// tokens and add the accounts to the renter's bot. Superadmin only — this is the
// ONLY place renter-submitted passwords are ever returned, and they are never
// exposed to the renter or to any non-superadmin.
router.get(
  "/renter-submissions/:id/creds",
  requireSuperadmin,
  async (req, res) => {
    try {
      const sub = await RenterSubmission.findById(req.params.id).lean();
      if (!sub)
        return res.status(404).json({ success: false, message: "Not found" });
      if (!sub.accountsEnc) return res.json({ success: true, accounts: [] });
      let parsed;
      try {
        parsed = JSON.parse(decrypt(sub.accountsEnc) || "[]");
      } catch {
        return res
          .status(500)
          .json({ success: false, message: "Submission data is unreadable" });
      }
      res.json({
        success: true,
        accounts: (parsed || []).map((a) => ({
          username: (a && a.username) || "",
          password: (a && a.password) || "",
          email: (a && a.email) || "",
          clientSecret: (a && a.clientSecret) || "",
        })),
      });
    } catch (err) {
      console.error("renter creds error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// APPROVE — the operator pastes the account tokens (the ClientSecrets they
// fetched from the renter's username:password, in the normal bot-add format),
// those get written into the renter's bot, and the bot starts. `tokens` is
// optional: if the operator already added the accounts elsewhere, approve just
// starts the bot. The encrypted submission credentials are kept so a dead token
// can be re-fetched later.
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
      if (!renter || !renter.botFile) {
        return res
          .status(400)
          .json({ success: false, message: "Renter has no bot assigned" });
      }
      const host = hosts.resolveHost(renter.botHost);
      if (!host) {
        return res
          .status(400)
          .json({ success: false, message: "Renter's host is unknown" });
      }

      // Add the pasted account tokens to the renter's bot (optional).
      let added = 0;
      let skipped = 0;
      let skipReason = "";
      const tokensText = String((req.body && req.body.tokens) || "");
      if (tokensText.trim()) {
        const games = await getConfigGames(host, renter.botFile);
        const parsed = parseAccounts(tokensText, games);
        if (!parsed.length) {
          return res.status(400).json({
            success: false,
            message:
              "No valid account tokens found. Paste tokens (one per line), or login token, or the JSON from a config.",
          });
        }
        const { kept, skipped: sk } = await dedupeAccounts(parsed);
        skipped = sk.length;
        if (sk.length) skipReason = sk[0].reason || "";
        const used = await RenterAccount.countDocuments({ renter: renter._id });
        if (used + kept.length > (Number(renter.maxAccounts) || 0)) {
          return res.status(400).json({
            success: false,
            message:
              "That would exceed the renter's limit (" +
              renter.maxAccounts +
              "); their inventory already has " +
              used +
              ".",
          });
        }
        if (kept.length) {
          try {
            const r = await addRenterAccountsToConfig(
              host,
              renter.botFile,
              kept,
              renter._id,
            );
            added = r.added;
          } catch (e) {
            return res.status(e.unreachable ? 502 : 500).json({
              success: false,
              offline: !!e.unreachable,
              message: "Could not write the accounts to the bot: " + (e.message || e),
            });
          }
        }
      }

      sub.status = "approved";
      sub.reviewedBy = req.session.admin.id;
      sub.reviewedAt = new Date();
      sub.added = added || sub.count;
      await sub.save();

      // Start the renter's bot.
      let botStarted = false;
      let startNote = "";
      try {
        await startConfigContainer(host, renter.botFile);
        botStarted = true;
        renter.botStoppedAt = null;
        await renter.save();
      } catch (e) {
        startNote =
          e.code === "no_accounts"
            ? "No accounts on the bot yet — paste the tokens, then approve."
            : e.code === "disabled"
              ? "Bot control is disabled on this server."
              : e.unreachable
                ? "Host is offline — start the bot when it's back."
                : e.message || "Could not start the bot.";
      }
      const parts = [];
      if (added) parts.push("Added " + added + " account(s).");
      if (skipped) {
        parts.push(
          skipped +
            " skipped — " +
            (skipReason || "already assigned to another bot") +
            ".",
        );
      }
      if (botStarted) parts.push("Bot is starting.");
      else if (!added && skipped)
        parts.push(
          "Nothing new to add, so the bot wasn't started. Use accounts that aren't already on another bot, or free them first.",
        );
      else if (startNote) parts.push(startNote);
      res.json({
        success: true,
        added,
        skipped,
        skipReason,
        botStarted,
        note: parts.join(" ") || "Approved.",
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
