// Superadmin management of renters + the account-submission approval queue.
// Every route is requireSuperadmin. The operator reveals a submission's
// credentials, fetches the device-auth tokens themselves, adds the accounts to
// the renter's bot with the existing tools, then Approves — which marks the
// batch approved and starts the renter's bot. Nothing here is driven by renter
// input, and renter-submitted credentials are only ever revealed to a superadmin.
const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");

const { requireSuperadmin } = require("../middleware/auth");
const Renter = require("../models/Renter");
const RenterSubmission = require("../models/RenterSubmission");
const RenterAccount = require("../models/RenterAccount");
const RenterDrop = require("../models/RenterDrop");
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const DropLog = require("../models/DropLog");
const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const {
  poolAccountEligibility,
  pickCount,
} = require("../utils/renterPoolEligibility");
const renterDropScanner = require("../utils/renterDropScanner");
const {
  createRenter,
  setPassword,
  sanitizeRenter,
  revealPassword,
  normGames,
  MIN_PASSWORD,
} = require("../utils/renters");
const {
  otherSharers,
  stopRenterFarming,
  startRenterFarming,
  applyRenterGames,
} = require("../utils/renterBotOps");
const MarketplaceListing = require("../models/MarketplaceListing");
const { detachAccountFromListing } = require("../utils/listingDetach");
const hosts = require("../utils/botHosts");
const { decrypt, encrypt } = require("../utils/secretBox");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const {
  listStacks,
  requireStack,
  findStack,
  setStackCapacity,
  normalizeCapacity,
  stackKey,
  chooseAvailableStack,
} = require("../utils/renterBotStacks");
const {
  restartConfigContainer,
  containerForFile,
  validFile,
  parseAccounts,
  dedupeAccounts,
  addRenterAccountsToConfig,
  provisionEmptyConfig,
  getConfigGames,
  removeAccountFromConfig,
  countConfigAccounts,
} = require("./botConfigRoutes");

const router = express.Router();

function botWriteStatus(err) {
  if (err && err.unreachable) return 502;
  if (err && ["rental_stack_full", "not_rental_stack"].includes(err.code)) {
    return 409;
  }
  return 500;
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

// Validate + normalise a bot assignment. Empty = unassigned (allowed). Only a
// config registered as a dedicated rental stack may be selected; normal
// operator bots are never valid targets even if a client posts one directly.
// A stack already used by another renter is allowed, subject to its account
// capacity when accounts are added.
async function resolveAssignment(botHost, botFile) {
  botHost = String(botHost || "");
  botFile = String(botFile || "");
  if (!botFile) return { botHost: botHost || "", botFile: "" };
  const host = hosts.resolveHost(botHost);
  if (!host) throw new Error("Unknown host");
  if (!validFile(botFile)) throw new Error("Invalid config file");
  await requireStack(host.id, botFile);
  return { botHost: host.id, botFile };
}

// FavouriteGames default for accounts added to this renter: their own armed
// games when set, else whatever the config farms.
async function renterDefaultGames(renter, host) {
  if (Array.isArray(renter.farmGames) && renter.farmGames.length) {
    return renter.farmGames.slice();
  }
  return getConfigGames(host, renter.botFile);
}

// Accounts held per renter. One grouped query for the whole list — this used to
// be a countDocuments per renter inside the map, and against the Atlas shared
// tier (which serialises concurrent queries) ten renters cost ~1.7s of the
// page's load for a number that one aggregate answers in one round trip.
async function usedByRenter(ids) {
  const rows = await RenterAccount.aggregate([
    ...(ids ? [{ $match: { renter: { $in: ids } } }] : []),
    { $group: { _id: "$renter", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

async function renterListView(r, pmap, umap) {
  const used = umap
    ? umap.get(String(r._id)) || 0
    : await RenterAccount.countDocuments({ renter: r._id });
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
    const [renters, pmap, umap] = await Promise.all([
      Renter.find({}).sort({ createdAt: -1 }).lean(),
      pendingByRenter(),
      usedByRenter(null),
    ]);
    const out = await Promise.all(
      renters.map((r) => renterListView(r, pmap, umap)),
    );
    res.json({ success: true, renters: out });
  } catch (err) {
    console.error("renters list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Bot picker: dedicated rental stacks only + who (if anyone) rents each one.
//
// Listing a directory is the whole job here, so the only real cost is talking to
// the hosts — and both halves of that used to be paid the slowest possible way:
//
//   * Hosts were walked ONE AFTER ANOTHER. They are independent machines, so
//     the endpoint charged the SUM of them for no reason.
//   * A host that is simply switched off never answers, and the default read is
//     deliberately patient (3 attempts at a 20s connect timeout) because the Pi
//     flaps under load. Measured on prod 2026-08-11 with the phone host down:
//     local 1ms, pi 496ms, phone 63106ms — 63s of an endpoint that had 500ms of
//     work to do, and the renters page awaited it before loading anything else.
//
// So: ask every host at once, and give each a budget appropriate to a picker.
// A host that misses it is reported as offline rather than silently dropped —
// the page says so, instead of showing a short list as if those bots no longer
// existed.
const PICKER_READ_TIMEOUT_MS = 8000;

async function rentalStackOptions() {
  const stacks = await listStacks();
  const byHost = new Map();
  for (const stack of stacks) {
    if (!byHost.has(stack.host)) byHost.set(stack.host, []);
    byHost.get(stack.host).push(stack);
  }
  const perHost = await Promise.all(
    [...byHost.entries()].map(async ([hostId, hostStacks]) => {
      const host = hosts.resolveHost(hostId);
      const meta = hosts.listHosts().find((h) => h.id === hostId) || {
        id: hostId,
        label: hostId,
      };
      if (!host) return { meta, rows: [], online: false };
      try {
        const existing = new Set(
          await hosts.readdir(host, {
            timeout: PICKER_READ_TIMEOUT_MS,
            retries: 0,
          })
        );
        const files = hostStacks
          .map((stack) => stack.file)
          .filter((file) => existing.has(file));
        const raws = await hosts.readFiles(host, files);
        const rows = [];
        for (const stack of hostStacks) {
          const raw = raws[stack.file];
          if (!raw || !raw.ok) continue;
          try {
            const data = JSON.parse(raw.text);
            const users =
              data && data.TwitchSettings &&
              Array.isArray(data.TwitchSettings.TwitchUsers)
                ? data.TwitchSettings.TwitchUsers
                : [];
            rows.push({ ...stack, accounts: users.length });
          } catch {
            /* an unreadable stack is not offered for assignment */
          }
        }
        return { meta, rows, online: true };
      } catch {
        return { meta, rows: [], online: false };
      }
    }),
  );
  const out = [];
  const offline = [];
  for (const h of perHost) {
    if (!h.online) offline.push({ id: h.meta.id, label: h.meta.label });
    for (const stack of h.rows) {
      const capacity = Math.max(1, Number(stack.capacity) || 10);
      out.push({
        host: h.meta.id,
        hostLabel: h.meta.label,
        file: stack.file,
        capacity,
        accounts: stack.accounts,
        remaining: Math.max(0, capacity - stack.accounts),
      });
    }
  }
  const assigned = await Renter.find(
    { botFile: { $gt: "" } },
    { botHost: 1, botFile: 1, username: 1 },
  ).lean();
  const amap = new Map();
  for (const a of assigned) {
    const k = stackKey(a.botHost, a.botFile);
    if (!amap.has(k)) amap.set(k, []);
    amap.get(k).push(a.username);
  }
  out.forEach((o) => {
    const names = amap.get(stackKey(o.host, o.file)) || [];
    o.assignedTo = names[0] || null;
    o.renters = names;
  });
  return { bots: out, offlineHosts: offline };
}

async function availableRentalStack() {
  const options = await rentalStackOptions();
  return chooseAvailableStack(options.bots);
}

router.get("/renters/bots", requireSuperadmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await rentalStackOptions()) });
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
        {
          $group: {
            _id: "$renter",
            n: { $sum: 1 },
            // Token health per renter, so a dead token shows up in the
            // overview instead of silently farming nothing.
            bad: {
              $sum: {
                $cond: [{ $eq: ["$lastScanStatus", "token_invalid"] }, 1, 0],
              },
            },
          },
        },
      ]),
      RenterDrop.aggregate([
        { $match: { renter: { $in: ids } } },
        { $group: { _id: "$renter", n: { $sum: 1 } } },
      ]),
    ]);
    const accMap = new Map(accAgg.map((a) => [String(a._id), a.n]));
    const badMap = new Map(accAgg.map((a) => [String(a._id), a.bad || 0]));
    const dropMap = new Map(dropAgg.map((a) => [String(a._id), a.n]));

    // How many renters share each config, so the overview can flag shared bots.
    const shareCount = new Map();
    for (const r of renters) {
      const k = (r.botHost || "") + "|" + r.botFile;
      shareCount.set(k, (shareCount.get(k) || 0) + 1);
    }

    const bots = [];
    for (const r of renters) {
      const host = hosts.resolveHost(r.botHost);
      let hostLabel = r.botHost;
      if (host) hostLabel = host.label;
      bots.push({
        renterId: String(r._id),
        username: r.username,
        status: r.status,
        host: r.botHost,
        hostLabel,
        file: r.botFile,
        container: containerForFile(r.botFile),
        // Deliberately absent, not false: this response never talks to a host,
        // so "is it running" is UNKNOWN here rather than "offline". The page
        // paints these rows immediately and fills the real state in from
        // /renter-bots/live, which is the call that pays for SSH.
        online: null,
        running: null,
        accounts: accMap.get(String(r._id)) || 0,
        tokenIssues: badMap.get(String(r._id)) || 0,
        drops: dropMap.get(String(r._id)) || 0,
        sharedBy: shareCount.get((r.botHost || "") + "|" + r.botFile) || 1,
      });
    }
    res.json({ success: true, bots });
  } catch (err) {
    console.error("renter-bots list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Live container state for the rented bots — the half of /renter-bots that has
// to shell out to each host.
//
// Split off deliberately. Deriving Running/Stopped means `docker ps -a` on the
// host, and these bots live on a Raspberry Pi reached over Tailscale: measured
// 2026-08-11 at 2975ms on a cold SSH master. Folded into the list endpoint that
// cost was paid before the page could paint anything at all, so the whole
// renters page felt broken while it waited on a home internet connection.
//
// Hosts are queried CONCURRENTLY (the list endpoint used to walk them in
// sequence), so the response costs one slow host, not the sum of them.
router.get("/renter-bots/live", requireSuperadmin, async (req, res) => {
  try {
    const renters = await Renter.find({ botFile: { $gt: "" } }, { botHost: 1, botFile: 1 })
      .lean();
    const hostIds = [
      ...new Set(renters.map((r) => r.botHost || "").filter(Boolean)),
    ];
    const psByHost = new Map();
    await Promise.all(
      hostIds.map(async (id) => {
        const host = hosts.resolveHost(id);
        if (!host) return psByHost.set(id, null);
        try {
          psByHost.set(id, await hosts.dockerPs(host));
        } catch {
          psByHost.set(id, null); // host offline / unreachable
        }
      }),
    );
    const live = renters.map((r) => {
      const states = psByHost.get(r.botHost || "");
      let running = null;
      const online = !!states;
      if (states) {
        const st = states[containerForFile(r.botFile)];
        running = !!(st && /^running/i.test(st.state || ""));
      }
      return { renterId: String(r._id), online, running };
    });
    res.json({ success: true, live });
  } catch (err) {
    console.error("renter-bots live error:", err.message);
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

// Small type-ahead used by Quick farm. It searches live/upcoming Twitch
// campaigns first, then the known operator/renter archives and market research.
// Only a short matching result set is returned; the page never downloads a
// giant select list.
router.get("/renters/game-search", requireSuperadmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q.length < 2) return res.json({ success: true, games: [] });
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const match = { game: re };
    const [campaigns, research, operatorDrops, renterDrops] = await Promise.all([
      TwitchCampaign.distinct("game", { active: true, ...match }),
      MarketResearch.distinct("game", match),
      DropLog.distinct("game", match),
      RenterDrop.distinct("game", match),
    ]);
    const byLower = new Map();
    for (const game of [...campaigns, ...research, ...operatorDrops, ...renterDrops]) {
      const value = String(game || "").trim();
      if (value) byLower.set(value.toLowerCase(), value);
    }
    const lower = q.toLowerCase();
    const games = [...byLower.values()]
      .sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(lower) ? 0 : 1;
        const bStarts = b.toLowerCase().startsWith(lower) ? 0 : 1;
        return aStarts - bStarts || a.localeCompare(b);
      })
      .slice(0, 20);
    res.json({ success: true, games });
  } catch (err) {
    console.error("renter game search error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Look up a Twitch account's stored client token by login, across everything
// the server already knows: the operator's bot index, other renters'
// inventories, and the account pool. Lets the manual-add form skip the token
// field when the account is already on the server. Never returns the token
// itself — only where it was found; the add route resolves it server-side.
router.get("/renters/account-token", requireSuperadmin, async (req, res) => {
  try {
    const username = String(req.query.username || "").trim();
    if (!username) {
      return res
        .status(400)
        .json({ success: false, message: "Username required" });
    }
    const found = await findStoredToken(username);
    res.json({
      success: true,
      found: !!found,
      source: found ? found.source : null,
    });
  } catch (err) {
    console.error("account token lookup error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Shared login → stored-token resolver (used by the lookup above and by
// manual-add when the token field is left empty).
async function findStoredToken(username) {
  const lower = username.toLowerCase();
  const loginRe = new RegExp(
    "^" + lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
    "i",
  );
  const bot = await BotAccount.findOne(
    { login: loginRe, clientSecret: { $nin: ["", null] } },
    { clientSecret: 1 },
  ).lean();
  if (bot) return { token: bot.clientSecret, source: "your bot index" };
  const rent = await RenterAccount.findOne(
    { login: loginRe, clientSecret: { $nin: ["", null] } },
    { clientSecret: 1, renter: 1 },
  ).lean();
  if (rent) {
    const owner = await Renter.findById(rent.renter, { username: 1 }).lean();
    return {
      token: rent.clientSecret,
      source: owner ? "renter " + owner.username : "another renter",
    };
  }
  const pool = await AvailableAccount.findOne(
    { usernameLower: lower, clientSecret: { $nin: ["", null] } },
    { clientSecret: 1 },
  ).lean();
  if (pool) return { token: pool.clientSecret, source: "the account pool" };
  return null;
}

// CREATE a renter. Either share an existing config (botHost/botFile) or, with
// newBotHost, provision a fresh config slot on that host in the same step.
router.post("/renters", requireSuperadmin, async (req, res) => {
  try {
    const b = req.body || {};
    let botHost = "";
    let botFile = "";
    if (b.newBotHost) {
      // Validate the renter details BEFORE provisioning, so a bad username
      // doesn't leave an orphaned empty config slot behind.
      const uname = String(b.username || "").trim();
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(uname)) {
        return res.status(400).json({
          success: false,
          message: "Username must be 3–32 chars: letters, numbers, and . _ - only",
        });
      }
      if (await Renter.exists({ usernameLower: uname.toLowerCase() })) {
        return res.status(400).json({
          success: false,
          message: "A renter with that username already exists",
        });
      }
      if (String(b.password || "").length < MIN_PASSWORD) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least " + MIN_PASSWORD + " characters",
        });
      }
      const host = hosts.resolveHost(b.newBotHost);
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
      botHost = host.id;
      botFile = slot.file;
    } else {
      ({ botHost, botFile } = await resolveAssignment(b.botHost, b.botFile));
    }
    const renter = await createRenter({
      username: b.username,
      password: b.password,
      displayName: b.displayName,
      botHost,
      botFile,
      farmGames: b.farmGames,
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
    // The renter's account roster with scan health, so the operator can spot a
    // dead token from the Manage panel (and rescan it) without SSH. Never
    // includes clientSecret.
    const accounts = await RenterAccount.find(
      { renter: r._id },
      {
        login: 1,
        lastScanStatus: 1,
        lastScanAt: 1,
        lastScanError: 1,
        dropCount: 1,
        farmUntil: 1,
        farmEndedAt: 1,
        enabled: 1,
      },
    )
      .sort({ login: 1 })
      .lean();
    res.json({
      success: true,
      renter: view,
      bot,
      accounts: accounts.map((a) => ({
        id: String(a._id),
        login: a.login || "",
        status: a.lastScanStatus || "pending",
        error: a.lastScanError || "",
        dropCount: a.dropCount || 0,
        lastScanAt: a.lastScanAt || null,
        farmUntil: a.farmUntil || null,
        farmEndedAt: a.farmEndedAt || null,
        enabled: a.enabled !== false,
      })),
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
      );
      r.botHost = botHost;
      r.botFile = botFile;
    }
    let gamesChanged = false;
    if (b.farmGames !== undefined) {
      const list = normGames(b.farmGames);
      gamesChanged = JSON.stringify(list) !== JSON.stringify(r.farmGames || []);
      r.farmGames = list;
    }
    if (b.displayName !== undefined) r.displayName = String(b.displayName).slice(0, 80);
    if (b.notes !== undefined) r.notes = String(b.notes).slice(0, 500);
    if (b.maxAccounts !== undefined)
      r.maxAccounts = Math.max(0, Math.floor(Number(b.maxAccounts) || 0));
    if (b.accessStart !== undefined)
      r.accessStart = b.accessStart ? new Date(b.accessStart) : null;
    if (b.accessEnd !== undefined) {
      r.accessEnd = b.accessEnd ? new Date(b.accessEnd) : null;
      // A lease that now ends in the future (or never) invalidates the "expiry
      // sweep already stopped this bot" stamp — without this, the sweep (which
      // filters on botStoppedAt: null) would never stop the bot when the
      // extended lease lapses.
      if (!r.accessEnd || r.accessEnd > new Date()) r.botStoppedAt = null;
    }
    await r.save();
    // Arm the new games on their existing accounts right away (best effort —
    // an offline host doesn't fail the save; the list still applies to any
    // account added later).
    let gamesApplied = null;
    if (gamesChanged && r.botFile) {
      const host = hosts.resolveHost(r.botHost);
      if (host) {
        try {
          const out = await applyRenterGames(r, host, r.farmGames);
          await restartConfigContainer(host, r.botFile).catch(() => {});
          gamesApplied = out.scope;
        } catch (e) {
          console.error("renter games apply:", e.message);
        }
      }
    }
    res.json({ success: true, renter: sanitizeRenter(r), gamesApplied });
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
          // Shared-bot aware: alone on the config the container is stopped;
          // sharing it, only this renter's accounts are pulled so the other
          // renters keep farming.
          await stopRenterFarming(r, host);
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
  const sharers = await otherSharers(renter);
  const stack = await findStack(host.id, renter.botFile);
  return {
    assigned: true,
    running,
    accounts,
    host: host.id,
    hostLabel: host.label,
    file: renter.botFile,
    capacity: stack ? stack.capacity : null,
    sharedWith: sharers.map((s) => s.username),
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

// Change the account CAPACITY of the rental stack this renter is on. This is
// the per-config cap (RenterBotStack.capacity) that actually gates how many
// Twitch accounts the bot may hold — a different limit from Renter.maxAccounts,
// which only sizes the renter's own pool quota. Bounded 1..100. A stack can be
// shared by several renters, so this affects every renter on the same config;
// the UI surfaces that. Refuses to drop the cap below what the config already
// holds, which would leave the stack permanently full and unable to accept adds.
router.put(
  "/renters/:id/stack-capacity",
  requireSuperadmin,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: "Bad renter id" });
      }
      const r = await Renter.findById(req.params.id);
      if (!r)
        return res.status(404).json({ success: false, message: "Not found" });
      if (!r.botFile) {
        return res
          .status(400)
          .json({ success: false, message: "This renter has no bot assigned." });
      }
      const host = hosts.resolveHost(r.botHost);
      if (!host) {
        return res.status(400).json({
          success: false,
          message: "Unknown host for this renter's bot.",
        });
      }

      const capacity = normalizeCapacity(req.body && req.body.capacity);
      if (capacity == null) {
        return res.status(400).json({
          success: false,
          message: "Capacity must be a whole number between 1 and 100.",
        });
      }

      // Must already be a registered rental stack (clear 409 otherwise).
      await requireStack(host.id, r.botFile);

      // Never set the cap below what the config physically holds. Best effort —
      // an unreadable host simply skips this guard, since capacity is a DB value
      // and the add-time assertCapacity re-checks against the live config anyway.
      let current = null;
      try {
        current = await countConfigAccounts(host, r.botFile);
      } catch {
        current = null;
      }
      if (current != null && capacity < current) {
        return res.status(409).json({
          success: false,
          message:
            "This bot already holds " +
            current +
            " account(s). Set the capacity to " +
            current +
            " or higher.",
        });
      }

      const row = await setStackCapacity(host.id, r.botFile, capacity);
      if (!row) {
        return res.status(409).json({
          success: false,
          message: "That config is not a dedicated rental stack.",
        });
      }
      res.json({
        success: true,
        capacity: row.capacity,
        used: current,
        remaining: current == null ? null : Math.max(0, row.capacity - current),
      });
    } catch (err) {
      const status =
        err && ["not_rental_stack", "bad_capacity"].includes(err.code)
          ? 409
          : 500;
      if (status === 500) {
        console.error("renter stack-capacity error:", err.message);
      }
      res
        .status(status)
        .json({ success: false, message: err.message || "Server error" });
    }
  },
);

// LIVE LOGS for a renter's bot — the same docker-logs tail the operator's Bots
// page offers (/bot-configs/logs/:file), but the container is always derived
// from the renter's own record instead of a client-supplied file, so this can
// never be pointed at someone else's bot. The frontend polls it.
router.get("/renters/:id/bot/logs", requireSuperadmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad renter id" });
    }
    const r = await Renter.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: "Not found" });
    if (!r.botFile) {
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
    const container = containerForFile(r.botFile);
    const logs = await hosts.dockerLogs(host, container, { tail: req.query.tail });
    res.json({ success: true, container, logs });
  } catch (e) {
    res.status(e.unreachable ? 502 : 500).json({
      success: false,
      offline: !!e.unreachable,
      message: e.unreachable
        ? "The bot host is offline right now."
        : e.message || "Could not read the logs.",
    });
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
    // Shared-bot aware: on a config with other active renters, start/stop
    // moves only THIS renter's accounts in or out of the config instead of
    // touching the container everyone shares.
    if (action === "start") {
      await startRenterFarming(r, host);
      r.botStoppedAt = null;
      await r.save();
    } else if (action === "stop") {
      await stopRenterFarming(r, host);
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
// Renter drop scanner — operator visibility + manual rescan
// ------------------------------------------------------------------

// Scanner progress (counts, current account, errors) for the Renting page.
router.get("/renter-scan/progress", requireSuperadmin, async (req, res) => {
  try {
    res.json({ success: true, progress: await renterDropScanner.getProgress() });
  } catch (err) {
    console.error("renter-scan progress error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Force-scan ONE renter account now — the fix for a stale "token_invalid"
// badge (transient GQL failures look like dead tokens; a fresh scan clears
// them) and the quickest way to confirm a replacement token works.
router.post(
  "/renter-accounts/:id/scan",
  requireSuperadmin,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Bad account id" });
      }
      const r = await renterDropScanner.scanAccountNow(req.params.id);
      if (!r.ok) {
        return res
          .status(400)
          .json({ success: false, message: r.error || "Scan failed" });
      }
      res.json({ success: true, newDrops: r.newDrops || 0, total: r.total || 0 });
    } catch (err) {
      console.error("renter account scan error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Where a renter account's Twitch password can be found. The account itself
// only ever stores the auth token (RenterAccount has no password field), so the
// login/password is looked up by username across the three places it can live:
// the renter's own submission, the account pool, and — for an account the
// operator moved onto the rental from their own fleet — the BotAccount record.
async function resolveAccountCreds(acc) {
  const login = String(acc.login || "");
  const lower = login.toLowerCase();
  const out = { password: "", email: "", source: "" };
  if (!login) return out;

  // 1. The renter submitted it themselves — their batch holds the credentials.
  const subs = await RenterSubmission.find(
    { renter: acc.renter, accountsEnc: { $gt: "" } },
    { accountsEnc: 1 },
  )
    .sort({ createdAt: -1 })
    .lean();
  for (const s of subs) {
    let parsed;
    try {
      parsed = JSON.parse(decrypt(s.accountsEnc) || "[]");
    } catch {
      continue;
    }
    const hit = (parsed || []).find(
      (a) => a && String(a.username || "").toLowerCase() === lower,
    );
    if (hit && hit.password) {
      out.password = hit.password;
      out.email = hit.email || "";
      out.source = "renter submission";
      return out;
    }
  }

  // 2. The account pool (where an operator-supplied account's credentials are
  //    parked once it is handed to a renter).
  const pool = await AvailableAccount.findOne({ usernameLower: lower }).lean();
  if (pool && pool.password) {
    const pw = decrypt(pool.password);
    if (pw) {
      out.password = pw;
      out.email = pool.email ? decrypt(pool.email) || "" : "";
      out.source = "account pool";
      return out;
    }
  }

  // 3. The operator's own record, for an account still tracked there.
  const bot = await BotAccount.findOne({ login }).lean();
  if (bot && bot.credPassword) {
    const pw = decrypt(bot.credPassword);
    if (pw) {
      out.password = pw;
      out.email = bot.credEmail ? decrypt(bot.credEmail) || "" : "";
      out.source = "bot account";
      return out;
    }
  }
  return out;
}

// REVEAL one renter account's live credentials — Twitch login, the auth token
// the bot runs on (ClientSecret), and the password if it is stored anywhere.
// Superadmin only, and never returned by the roster endpoint: the renter's own
// /renter/accounts deliberately exposes neither token nor password.
router.get("/renter-accounts/:id/creds", requireSuperadmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad account id" });
    }
    const acc = await RenterAccount.findById(req.params.id).lean();
    if (!acc)
      return res.status(404).json({ success: false, message: "Not found" });
    const creds = await resolveAccountCreds(acc);
    res.json({
      success: true,
      account: {
        login: acc.login || "",
        token: acc.clientSecret || "",
        password: creds.password,
        email: creds.email,
        source: creds.source,
        host: acc.host || "",
        configFile: acc.configFile || "",
        status: acc.lastScanStatus || "pending",
      },
    });
  } catch (err) {
    console.error("renter account creds error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// FULL ACCOUNT ROSTER across renters, with the credentials inline — the
// renting system's own account list. Renter accounts are deliberately absent
// from the Drops Archive (separate tenant inventory), so this is the only
// place the operator can see username + password + client token together.
// Superadmin only; ?renter=<id> narrows it to one renter.
router.get("/renter-accounts", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    const rid = req.query.renter;
    if (rid && rid !== "all" && mongoose.isValidObjectId(rid)) {
      q.renter = new mongoose.Types.ObjectId(rid);
    }
    const accs = await RenterAccount.find(q).sort({ login: 1 }).limit(500).lean();
    const renters = await Renter.find(
      { _id: { $in: [...new Set(accs.map((a) => String(a.renter)))] } },
      { username: 1 },
    ).lean();
    const rmap = new Map(renters.map((r) => [String(r._id), r.username]));
    const out = [];
    for (const a of accs) {
      // Credentials come from wherever this account's password lives (renter
      // submission / pool / operator record) — same resolver the single-account
      // reveal uses.
      const creds = await resolveAccountCreds(a);
      out.push({
        id: String(a._id),
        renterId: String(a.renter),
        renter: rmap.get(String(a.renter)) || "",
        login: a.login || "",
        password: creds.password,
        email: creds.email,
        credSource: creds.source,
        token: a.clientSecret || "",
        host: a.host || "",
        configFile: a.configFile || "",
        enabled: a.enabled !== false,
        status: a.lastScanStatus || "pending",
        dropCount: a.dropCount || 0,
        farmUntil: a.farmUntil || null,
        farmEndedAt: a.farmEndedAt || null,
        addedAt: a.createdAt || null,
      });
    }
    res.json({ success: true, accounts: out });
  } catch (err) {
    console.error("renter-accounts list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// SET / CLEAR one account's farming window after the fact ("give it 15 more
// days", "make it open-ended"). Days are counted from now; days = 0 clears it.
router.post("/renter-accounts/:id/farm", requireSuperadmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad account id" });
    }
    const body = req.body || {};
    const days = Math.floor(Number(body.days));
    let farmUntil = null;
    if (body.farmUntil) {
      farmUntil = new Date(body.farmUntil);
      if (isNaN(farmUntil.getTime())) {
        return res.status(400).json({ success: false, message: "Bad date" });
      }
    } else if (Number.isFinite(days) && days > 0) {
      farmUntil = new Date(Date.now() + days * 86400000);
    }
    const acc = await RenterAccount.findByIdAndUpdate(
      req.params.id,
      // Clearing farmEndedAt re-arms the sweep for the new window, the same way
      // extending a renter's lease clears botStoppedAt.
      { $set: { farmUntil, farmEndedAt: null } },
      { new: true },
    ).lean();
    if (!acc) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, farmUntil: acc.farmUntil || null });
  } catch (err) {
    console.error("renter account farm error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// REMOVE one renter account (e.g. a dead one): pulled out of its bot config
// (with a restart so the change takes effect if the container is running) and
// deleted from the renter's inventory. The renter's farmed drops (RenterDrop)
// are kept — they are history, not the account.
router.delete(
  "/renter-accounts/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, message: "Bad account id" });
      }
      const acc = await RenterAccount.findById(req.params.id);
      if (!acc)
        return res.status(404).json({ success: false, message: "Not found" });

      let pulled = false;
      let note = "";
      if (acc.configFile) {
        const host = hosts.resolveHost(acc.host);
        if (host) {
          try {
            const removed = await removeAccountFromConfig(host, acc.configFile, {
              clientSecret: acc.clientSecret,
              login: acc.login,
            });
            if (removed) {
              pulled = true;
              try {
                const states = await hosts.dockerPs(host);
                const st = states[containerForFile(acc.configFile)];
                if (st && /^running/i.test(st.state || "")) {
                  await restartConfigContainer(host, acc.configFile);
                }
              } catch {
                note = "Removed, but the bot could not be restarted.";
              }
            }
          } catch (e) {
            // Host offline: refuse rather than leave a ghost entry farming in
            // the config with no matching inventory row.
            return res.status(502).json({
              success: false,
              message:
                "The bot host is unreachable — try again when it is online (" +
                e.message +
                ")",
            });
          }
        }
      }
      await RenterAccount.deleteOne({ _id: acc._id });
      res.json({
        success: true,
        pulled,
        note:
          note ||
          (pulled
            ? "Account removed and pulled off the bot."
            : "Account removed."),
      });
    } catch (err) {
      console.error("renter account delete error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// MANUAL ADD — operator types one account (username + password + client token)
// straight into a renter's bot. If that Twitch account is already farming
// anywhere on the server — an operator bot config or another renter's bot — it
// is pulled OUT of there first and moved onto this renter's bot, so the same
// account never farms in two places. Typical case: someone buys an account and
// then rents farming for it. Accounts attached to an ACTIVE marketplace listing
// are refused: they are promised to a future buyer.
router.post(
  "/renters/:id/accounts/manual",
  requireSuperadmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      const quick = body.quick === true;
      const requestedGames = normGames(body.games);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      let token = String(body.token || body.clientSecret || "").trim();
      // No token pasted? Use the one the server already stores for this login
      // (bot index / other renters / account pool).
      let tokenNote = "";
      if (username && !token) {
        const stored = await findStoredToken(username);
        if (stored) {
          token = stored.token;
          tokenNote = "Used the client token already stored (" + stored.source + ").";
        }
      }
      // Optional per-account farming window ("farm this one for 15 days").
      const farmDays = Math.floor(Number(body.farmDays));
      const farmUntil = body.farmUntil
        ? new Date(body.farmUntil)
        : Number.isFinite(farmDays) && farmDays > 0
          ? new Date(Date.now() + farmDays * 86400000)
          : null;
      if (farmUntil && isNaN(farmUntil.getTime())) {
        return res
          .status(400)
          .json({ success: false, message: "Bad farm end date" });
      }
      if (quick && !requestedGames.length) {
        return res.status(400).json({ success: false, message: "Choose a game for Quick farm" });
      }
      if (quick && (!Number.isFinite(farmDays) || farmDays <= 0) && !body.farmUntil) {
        return res.status(400).json({ success: false, message: "Choose a positive farming duration" });
      }
      if (!username || !token) {
        return res.status(400).json({
          success: false,
          message: username
            ? "No stored client token found for that username — paste it manually"
            : "Username is required",
        });
      }
      const renter = await Renter.findById(req.params.id);
      if (!renter)
        return res.status(404).json({ success: false, message: "Not found" });
      let assignedStack = null;
      let assignedForQuick = false;
      const used = await RenterAccount.countDocuments({ renter: renter._id });
      if (used + 1 > (Number(renter.maxAccounts) || 0)) {
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

      const lower = username.toLowerCase();
      const loginRe = new RegExp(
        "^" + lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
        "i",
      );

      // Already on THIS renter's inventory? Nothing to move.
      const mine = await RenterAccount.findOne({
        renter: renter._id,
        $or: [{ clientSecret: token }, { login: loginRe }],
      }).lean();
      if (mine) {
        return res.status(409).json({
          success: false,
          message: "That account is already in this renter's inventory",
        });
      }

      if (!renter.botFile && quick && body.autoAssign === true) {
        assignedStack = await availableRentalStack();
        if (!assignedStack) {
          return res.status(409).json({
            success: false,
            message: "No available rental bot stack has room right now",
          });
        }
        renter.botHost = assignedStack.host;
        renter.botFile = assignedStack.file;
        renter.botStoppedAt = null;
        await renter.save();
        assignedForQuick = true;
      }
      if (!renter.botFile) {
        return res
          .status(400)
          .json({ success: false, message: "Renter has no bot assigned" });
      }
      const host = hosts.resolveHost(renter.botHost);
      if (!host) {
        if (assignedForQuick) {
          renter.botHost = "";
          renter.botFile = "";
          await renter.save().catch(() => {});
        }
        return res
          .status(400)
          .json({ success: false, message: "Renter's host is unknown" });
      }

      const notes = [];
      let partial = false;
      if (tokenNote) notes.push(tokenNote);

      // Look up where the account currently lives — READS ONLY. Nothing is torn
      // down until the destination write below has succeeded. The identity
      // fields come from whichever trace exists so the config entry can carry
      // the Twitch Id / unique id TwitchDropsBot needs to watch drops.
      const acctRow = await BotAccount.findOne(
        { $or: [{ clientSecret: token }, { login: loginRe }] },
        { _id: 1, login: 1 },
      ).lean();
      const botHit = await BotAccount.findOne({
        configFile: { $nin: ["", null] },
        $or: [{ clientSecret: token }, { login: loginRe }],
      });
      const otherRenterAcc = await RenterAccount.findOne({
        $or: [{ clientSecret: token }, { login: loginRe }],
      });
      const poolRow = await AvailableAccount.findOne({
        usernameLower: lower,
      }).lean();
      const twitchId = String(
        (botHit && botHit.twitchId) ||
          (otherRenterAcc && otherRenterAcc.twitchId) ||
          (poolRow && poolRow.twitchId) ||
          "",
      ).trim();
      const uniqueId = String(
        (botHit && botHit.uniqueId) ||
          (otherRenterAcc && otherRenterAcc.uniqueId) ||
          (poolRow && poolRow.uniqueId) ||
          "",
      ).trim();
      const games = requestedGames.length
        ? requestedGames
        : await renterDefaultGames(renter, host);
      const acct = {
        ClientSecret: token,
        UniqueId: uniqueId || crypto.randomBytes(16).toString("hex"),
        Login: username,
        Id: twitchId,
        Enabled: true,
        FavouriteGames: games.slice(),
      };

      // DESTINATION FIRST. Write the account into the renter's bot BEFORE
      // pulling it out of anywhere else. If this fails the account has not been
      // touched at its source, so the operator can safely retry — the old
      // source-first order could strand an account (delisted, removed from its
      // bot, its RenterAccount row deleted) with nowhere left to land.
      try {
        await addRenterAccountsToConfig(host, renter.botFile, [acct], renter._id);
      } catch (e) {
        if (assignedForQuick) {
          renter.botHost = "";
          renter.botFile = "";
          await renter.save().catch(() => {});
        }
        return res.status(botWriteStatus(e)).json({
          success: false,
          offline: !!e.unreachable,
          message:
            "Could not write the account to the renter's bot: " +
            (e.message || e),
        });
      }

      const destHost = host;
      const destFile = renter.botFile;

      // The account is safely placed now, so tear down its old homes. A teardown
      // failure no longer loses the account — it is already farming for the
      // renter — so these WARN rather than abort; the worst case is the account
      // farms in two places until the operator frees the source by hand.

      // Pull the account off any ACTIVE marketplace listing that still promises
      // to deliver it — but only this one account, never the whole listing. On
      // a multi-account offer the other accounts keep selling; on a single-
      // account offer it goes off sale.
      const listingFilter = [
        {
          accountLogin: {
            $regex:
              "(^|[,\\s])" +
              lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "([,\\s]|$)",
            $options: "i",
          },
        },
      ];
      if (acctRow) {
        listingFilter.push({
          accountId: new RegExp("(^|,\\s*)" + String(acctRow._id) + "(\\s*,|$)"),
        });
      }
      const liveListings = await MarketplaceListing.find({
        status: "active",
        $or: listingFilter,
      });
      for (const row of liveListings) {
        const r = await detachAccountFromListing(
          row,
          { _id: acctRow && acctRow._id, login: (acctRow && acctRow.login) || username },
          { reason: "reclaimed for a renter", republish: false },
        );
        for (const d of r.detached) notes.push("Pulled off " + d + ".");
        for (const w of r.warnings) notes.push("⚠ " + w);
      }

      // Pull it out of an operator bot, if it lives on one.
      if (botHit) {
        const srcHost = hosts.resolveHost(botHit.host);
        const sameConfig =
          !!srcHost &&
          srcHost.id === destHost.id &&
          botHit.configFile === destFile;
        if (sameConfig) {
          // Already in the destination config (shared file) — the entry stays
          // (we just wrote it); only drop operator ownership so auto-farm and
          // fulfilment won't grab it.
          botHit.configFile = "";
          botHit.container = "";
          botHit.enabled = false;
          await botHit.save();
          notes.push(
            "Took " +
              (botHit.login ? botHit.login + " · " : "") +
              "over from operator use on the shared config.",
          );
        } else if (!srcHost) {
          partial = true;
          notes.push(
            "⚠ Still assigned to operator bot " +
              botHit.configFile +
              " on unknown host '" +
              botHit.host +
              "' — free it there manually.",
          );
        } else {
          let removed = 0;
          let removeErr = null;
          try {
            removed = await removeAccountFromConfig(srcHost, botHit.configFile, {
              clientSecret: botHit.clientSecret,
              login: botHit.login || username,
            });
          } catch (e) {
            removeErr = e;
          }
          if (removeErr) {
            partial = true;
            notes.push(
              "⚠ Added to the renter, but could not remove it from operator bot " +
                botHit.configFile +
                " on " +
                srcHost.label +
                " (" +
                (removeErr.message || removeErr) +
                ") — it will farm in both until you free it there.",
            );
          } else {
            if (removed) {
              // Best effort: bounce the source bot so it stops farming it.
              try {
                await restartConfigContainer(srcHost, botHit.configFile);
              } catch {
                notes.push(
                  "Removed from " +
                    botHit.configFile +
                    " on " +
                    srcHost.label +
                    ", but that bot could not be restarted — restart it so the change takes effect.",
                );
              }
            }
            botHit.configFile = "";
            botHit.container = "";
            botHit.enabled = false;
            await botHit.save();
            notes.push(
              "Moved off operator bot " +
                (botHit.login ? botHit.login + " · " : "") +
                (removed ? "" : "(config entry was already gone) ") +
                "on " +
                srcHost.label +
                ".",
            );
          }
        }
      }

      // Pull it off ANOTHER renter's bot, if it lives there.
      if (otherRenterAcc) {
        const srcHost = otherRenterAcc.configFile
          ? hosts.resolveHost(otherRenterAcc.host)
          : null;
        const sameConfig =
          !!srcHost &&
          srcHost.id === destHost.id &&
          otherRenterAcc.configFile === destFile;
        let keepRow = false;
        if (otherRenterAcc.configFile && srcHost && !sameConfig) {
          let removed = 0;
          let removeErr = null;
          try {
            removed = await removeAccountFromConfig(
              srcHost,
              otherRenterAcc.configFile,
              {
                clientSecret: otherRenterAcc.clientSecret,
                login: otherRenterAcc.login || username,
              },
            );
          } catch (e) {
            removeErr = e;
          }
          if (removeErr) {
            // Its config entry may still be live — keep the row so the trail to
            // it is not lost, and warn the operator to free it by hand.
            partial = true;
            keepRow = true;
            notes.push(
              "⚠ Added to the renter, but could not remove it from another renter's bot (" +
                otherRenterAcc.configFile +
                "): " +
                (removeErr.message || removeErr) +
                " — free it there manually.",
            );
          } else if (removed) {
            try {
              await restartConfigContainer(srcHost, otherRenterAcc.configFile);
            } catch {
              notes.push(
                "Removed from the other renter's bot, but it could not be restarted — restart it so the change takes effect.",
              );
            }
          }
        }
        if (!keepRow) {
          await RenterAccount.deleteOne({ _id: otherRenterAcc._id });
          notes.push(
            sameConfig
              ? "Took over from another renter on the shared config."
              : "Moved off another renter's bot.",
          );
        }
      }

      // Park the credentials in the account pool so the Creds reveal can always
      // find the password later, and mark it claimed so no new bot grabs it.
      const poolSet = {
        username,
        clientSecret: token,
        status: "claimed",
        claimedAt: new Date(),
        claimedNote: "rented to " + renter.username,
      };
      if (password) {
        poolSet.password = encrypt(password);
        poolSet.hasPassword = true;
      }
      const poolResult = await AvailableAccount.updateOne(
        { usernameLower: lower },
        { $set: poolSet, $setOnInsert: { usernameLower: lower } },
        { upsert: true },
      ).catch(() => {});
      const rentedPool = poolResult
        ? await AvailableAccount.findOne({ usernameLower: lower }, { _id: 1 }).lean().catch(() => null)
        : null;
      if (rentedPool && (poolResult.modifiedCount || poolResult.upsertedCount || poolResult.nModified)) {
        await recordPoolUsage(rentedPool._id, {
          event: "rented",
          actor: "renter-admin",
          note: poolSet.claimedNote,
        });
      }

      // Restart the renter's bot so it picks the new account up (best effort —
      // a stopped bot stays stopped until the operator starts it).
      let restarted = false;
      let started = false;
      try {
        const container = containerForFile(renter.botFile);
        const states = await hosts.dockerPs(host);
        const st = container && states[container];
        if (st && st.state === "running") {
          await restartConfigContainer(host, renter.botFile);
          restarted = true;
        } else if (quick) {
          await startRenterFarming(renter, host);
          started = true;
        }
      } catch {
        notes.push(quick ? "Added, but the renter's bot could not be started." : "Added, but the renter's bot could not be restarted.");
      }

      // Stamp the per-account lease on the row the config writer just created.
      if (farmUntil) {
        await RenterAccount.updateOne(
          { renter: renter._id, clientSecret: token },
          { $set: { farmUntil, farmEndedAt: null } },
        ).catch(() => {});
        notes.push(
          "Farms until " + farmUntil.toISOString().slice(0, 10) + ".",
        );
      }

      notes.unshift("Added " + username + " to " + renter.botFile + ".");
      if (assignedForQuick) notes.unshift("Assigned rental stack " + renter.botFile + " on " + host.label + ".");
      if (restarted) notes.push("Bot restarting.");
      if (started) notes.push("Bot started.");
      res.json({
        success: true,
        moved: !!(botHit || otherRenterAcc),
        partial,
        restarted,
        started,
        assignedStack: assignedForQuick ? { host: host.id, file: renter.botFile } : null,
        games,
        farmUntil: farmUntil || null,
        note: notes.join(" "),
      });
    } catch (err) {
      console.error("renter manual add error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

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
        const games = await renterDefaultGames(renter, host);
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
            return res.status(botWriteStatus(e)).json({
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
      // "added" is honest history: what the paste actually landed on the bot.
      // Only when NO tokens were pasted (operator added the accounts through
      // another tool first) do we assume the whole batch made it.
      sub.added = tokensText.trim() ? added : sub.count;
      await sub.save();

      // Start the renter's farming (shared-bot aware: a running shared
      // container is restarted so the new accounts load).
      let botStarted = false;
      let startNote = "";
      try {
        await startRenterFarming(renter, host);
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

// ------------------------------------------------------------------
// Add accounts from the operator's own account pool (AvailableAccount).
//
// Instead of the operator pasting username/token/password, auto-pick N
// pristine, unentangled pool accounts and feed them to a renter. "Unentangled"
// is the whole safety story: we never take an account that auto-farm is using,
// already selling, or has promised to a buyer — see utils/renterPoolEligibility
// and the guards in movePoolAccountToRenter (claim in pool = the auto-farm
// refiller can't redeploy it; see memory project_renting_out_own_accounts).
// ------------------------------------------------------------------

// Build the eligible-pool picture in bulk (no per-account N+1). Returns
// { candidates: [{doc, facts, eligibility}], eligible: [docs] }.
async function gatherPoolEligibility() {
  // Pristine pre-filter: verified, deployable, unclaimed pool rows only.
  const candidates = await AvailableAccount.find({
    status: "available",
    lastCheckStatus: "ok",
    hasPassword: true,
    clientSecret: { $nin: ["", null] },
  }).lean();
  if (!candidates.length) return { candidates: [], eligible: [] };

  const secrets = candidates.map((c) => c.clientSecret).filter(Boolean);

  // BotAccount traces for these tokens → deployed / sellable / sold sets.
  const bots = await BotAccount.find(
    { clientSecret: { $in: secrets } },
    { _id: 1, clientSecret: 1, configFile: 1, credPassword: 1, soldAt: 1, soldSetId: 1 },
  ).lean();
  const deployedTokens = new Set();
  const sellableTokens = new Set();
  const soldTokens = new Set();
  const botIdToToken = new Map();
  for (const b of bots) {
    botIdToToken.set(String(b._id), b.clientSecret);
    if (b.configFile) deployedTokens.add(b.clientSecret);
    if (b.credPassword) sellableTokens.add(b.clientSecret);
    if (b.soldAt || (b.soldSetId && String(b.soldSetId))) soldTokens.add(b.clientSecret);
  }
  // Any sold/reserved/connected drop on those accounts also disqualifies.
  if (bots.length) {
    const drops = await DropLog.find(
      {
        account: { $in: bots.map((b) => b._id) },
        $or: [
          { soldAt: { $ne: null } },
          { soldSetId: { $nin: ["", null] } },
          { connected: true },
        ],
      },
      { account: 1 },
    ).lean();
    for (const d of drops) {
      const tok = botIdToToken.get(String(d.account));
      if (tok) soldTokens.add(tok);
    }
  }

  // Logins auto-farm has assigned to a task.
  const assignedSet = new Set();
  const tasks = await AutoFarmTask.find({}, { assignedAccounts: 1 }).lean();
  for (const t of tasks) {
    for (const u of t.assignedAccounts || []) {
      const v = String(u || "").trim().toLowerCase();
      if (v) assignedSet.add(v);
    }
  }

  // Logins attached to any active marketplace listing.
  const listedSet = new Set();
  const listings = await MarketplaceListing.find(
    { status: "active" },
    { accountLogin: 1 },
  ).lean();
  for (const l of listings) {
    for (const p of String(l.accountLogin || "").split(/[,\s]+/)) {
      const v = p.trim().toLowerCase();
      if (v) listedSet.add(v);
    }
  }

  const out = candidates.map((c) => {
    const tok = c.clientSecret;
    const lower = String(c.username || "").trim().toLowerCase();
    let passwordDecryptable = false;
    try {
      passwordDecryptable = !!(c.password && decrypt(c.password));
    } catch {
      passwordDecryptable = false;
    }
    const facts = {
      status: c.status,
      clientSecret: tok,
      hasPassword: !!c.hasPassword,
      passwordDecryptable,
      lastCheckStatus: c.lastCheckStatus,
      deployedOnBot: deployedTokens.has(tok),
      hasSoldOrReservedDrops: soldTokens.has(tok),
      sellable: sellableTokens.has(tok),
      inAssignedAccounts: assignedSet.has(lower),
      onActiveListing: listedSet.has(lower),
    };
    return { doc: c, facts, eligibility: poolAccountEligibility(facts) };
  });
  return { candidates: out, eligible: out.filter((x) => x.eligibility.eligible).map((x) => x.doc) };
}

// Move ONE pool account into a renter. Assumes it was found eligible; still
// claims atomically (status guard) so a concurrent claim can't double-allocate.
async function movePoolAccountToRenter(renter, host, doc) {
  const token = doc.clientSecret;
  const username = String(doc.username || "").trim();
  const lower = username.toLowerCase();

  // Build the config entry BEFORE claiming: renterDefaultGames reads the config
  // off the host and can fail, and a failure here must not leave a claimed-but-
  // unplaced account behind.
  const games = await renterDefaultGames(renter, host);
  const acct = {
    ClientSecret: token,
    UniqueId: doc.uniqueId || crypto.randomBytes(16).toString("hex"),
    Login: username,
    Id: String(doc.twitchId || ""),
    Enabled: true,
    FavouriteGames: games.slice(),
  };

  // Guard 3: claim it in the pool so auto-farm's refiller can't redeploy it.
  const claimNote =
    "rented to " +
    renter.username +
    (renter.accessEnd
      ? " until " + new Date(renter.accessEnd).toISOString().slice(0, 10)
      : "");
  const claim = await AvailableAccount.updateOne(
    { _id: doc._id, status: "available" },
    { $set: { status: "claimed", claimedAt: new Date(), claimedNote: claimNote } },
  );
  if (!(claim.modifiedCount || claim.nModified)) {
    throw new Error("was claimed by someone else");
  }
  await recordPoolUsage(doc._id, { event: "rented", actor: "renter-admin", note: claimNote });

  // The account is now claimed. If writing it into the renter's config fails,
  // RELEASE the claim before propagating — otherwise it is stranded: claimed
  // (auto-farm's refiller skips it) yet in no config (farming nothing). The
  // release is scoped to a claim that is still OURS (status + note unchanged)
  // so it can't clobber a claim a concurrent move just took.
  try {
    await addRenterAccountsToConfig(host, renter.botFile, [acct], renter._id);
  } catch (e) {
    const returned = await AvailableAccount.updateOne(
      { _id: doc._id, status: "claimed", claimedNote: claimNote },
      { $set: { status: "available" }, $unset: { claimedAt: "", claimedNote: "" } },
    ).catch(() => {});
    if (returned && (returned.modifiedCount || returned.nModified)) {
      await recordPoolUsage(doc._id, { event: "returned", actor: "renter-admin" });
    }
    throw e;
  }

  // Defensive auto-farm guards on any stray BotAccount trace. Eligibility
  // already excluded deployed/sellable/sold accounts, so for a picked account
  // these are no-ops — kept as belt-and-braces so a race can never leave the
  // token both farming for the renter and reachable by auto-farm/fulfilment.
  await BotAccount.updateMany(
    { clientSecret: token },
    { $set: { configFile: "", container: "", enabled: false, credPassword: "", hasPassword: false } },
  ).catch(() => {});
  await AutoFarmTask.updateMany(
    { assignedAccounts: { $in: [username, lower] } },
    { $pull: { assignedAccounts: { $in: [username, lower] } } },
  ).catch(() => {});

  return username;
}

// Preview (read-only): what WOULD be taken for a given count.
router.get(
  "/renters/:id/accounts/from-pool/preview",
  requireSuperadmin,
  async (req, res) => {
    try {
      const renter = await Renter.findById(req.params.id);
      if (!renter)
        return res.status(404).json({ success: false, message: "Not found" });
      const requested = Math.floor(Number(req.query.count) || 0);
      const used = await RenterAccount.countDocuments({ renter: renter._id });
      const quotaRemaining = Math.max(
        0,
        (Number(renter.maxAccounts) || 0) - used,
      );
      const { eligible } = await gatherPoolEligibility();
      const willAdd = pickCount({
        requested,
        quotaRemaining,
        eligibleTotal: eligible.length,
      });
      res.json({
        success: true,
        botAssigned: !!renter.botFile,
        requested,
        eligibleTotal: eligible.length,
        quotaRemaining,
        willAdd,
        preview: eligible.slice(0, willAdd).map((a) => ({
          username: a.username,
          lastCheckStatus: a.lastCheckStatus || "",
          dropCount: a.dropCount || 0,
        })),
      });
    } catch (err) {
      console.error("renter from-pool preview error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Commit: auto-pick and move up to `count` eligible pool accounts.
router.post(
  "/renters/:id/accounts/from-pool",
  requireSuperadmin,
  async (req, res) => {
    try {
      const renter = await Renter.findById(req.params.id);
      if (!renter)
        return res.status(404).json({ success: false, message: "Not found" });
      if (!renter.botFile) {
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
      const requested = Math.floor(Number((req.body || {}).count) || 0);
      if (!(requested > 0)) {
        return res
          .status(400)
          .json({ success: false, message: "count must be a positive number" });
      }
      const used = await RenterAccount.countDocuments({ renter: renter._id });
      const quotaRemaining = Math.max(
        0,
        (Number(renter.maxAccounts) || 0) - used,
      );
      if (quotaRemaining <= 0) {
        return res.status(400).json({
          success: false,
          message:
            "Renter is already at their account limit (" +
            renter.maxAccounts +
            ").",
        });
      }

      const { eligible } = await gatherPoolEligibility();
      const n = pickCount({
        requested,
        quotaRemaining,
        eligibleTotal: eligible.length,
      });
      if (n <= 0) {
        return res.status(409).json({
          success: false,
          message: eligible.length
            ? "No quota room to add accounts."
            : "No eligible pristine pool accounts to add right now.",
        });
      }

      const picked = eligible.slice(0, n);
      const added = [];
      const skipped = [];
      for (const doc of picked) {
        // Re-validate at move time (close the select→move race).
        const fresh = await AvailableAccount.findById(doc._id).lean();
        if (!fresh || fresh.status !== "available") {
          skipped.push({ username: doc.username, reason: "no longer available" });
          continue;
        }
        try {
          added.push(await movePoolAccountToRenter(renter, host, fresh));
        } catch (e) {
          skipped.push({ username: doc.username, reason: e.message || String(e) });
        }
      }

      // Restart the renter's bot once so it picks up the new accounts.
      let restarted = false;
      if (added.length) {
        try {
          const container = containerForFile(renter.botFile);
          const states = await hosts.dockerPs(host);
          const st = container && states[container];
          if (st && st.state === "running") {
            await restartConfigContainer(host, renter.botFile);
            restarted = true;
          }
        } catch {
          /* best effort — a stopped bot stays stopped until the operator starts it */
        }
      }

      res.json({
        success: true,
        added: added.length,
        addedLogins: added,
        skipped,
        restarted,
        message:
          "Added " +
          added.length +
          " account(s) from the pool to " +
          renter.botFile +
          (restarted ? " — bot restarting." : "") +
          (skipped.length ? " " + skipped.length + " skipped." : ""),
      });
    } catch (err) {
      console.error("renter from-pool add error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
