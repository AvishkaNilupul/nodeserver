// ---------------------------------------------------------------------------
// Standalone NO-CLAIM FARMING system.
//
// Some games (Overwatch, Rainbow Six) can't be sold via the normal
// click-claim-then-sell flow: the drop has to be left UNCLAIMED so the buyer
// connects their own game account and claims it. This is a self-contained
// console for exactly those games, separate from the auto-farmer / Drop Archive
// / scanner / listings:
//
//   * bots run the no-claim build (ClaimDrops:false) as their own Docker
//     containers in a DEDICATED Pi directory (BASE), never the managed bot dir;
//   * accounts are pulled from the shared pool (AvailableAccount), respecting
//     the auto-farm reserve so this never starves it;
//   * source of truth is the per-bot config files on the Pi (like the Bots
//     page) — no new Mongo model, nothing coupled to the old systems;
//   * it never creates listings — the operator lists manually from the account
//     credentials this page surfaces.
//
// Every heavy read (per-bot accounts, live drop inventory) is a separate
// on-demand endpoint so the page opens on a cheap summary and only does slow
// work when a row is expanded.
// ---------------------------------------------------------------------------
const express = require("express");
const path = require("path");
const fsp = require("fs/promises");

const { requireSuperadmin } = require("../middleware/auth");
const hosts = require("../utils/botHosts");
const settings = require("../utils/settings");
const twitchInventory = require("../utils/twitchInventory");
const { buildSocialPost } = require("../utils/socialPost");
const { buildSetGridImage } = require("../utils/setImage");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");
const { decrypt } = require("../utils/secretBox");
const { recordPoolUsage } = require("../utils/poolUsageLog");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const noclaimWatcher = require("../utils/noclaimWatcher");
const unclaimedAutoList = require("../utils/unclaimedAutoList");

const router = express.Router();

// --- Sandbox constants + bot machinery -------------------------------------
//
// All of this used to be defined inline here. It moved to utils/noclaimFleet.js
// when the fleet allocator (utils/unclaimedAllocator.js) needed the same
// primitives — claiming from the pool, writing a config, starting a container —
// because a second copy of the claim path would drift from this one. Imported
// under the same names so every handler below reads exactly as it did.
const fleet = require("../utils/noclaimFleet");
const {
  BASE,
  BOTS_DIR,
  IMAGE,
  CONTAINER_PREFIX,
  MAX_PER_BOT,
  pi,
  sh,
  containerFor,
  botDir,
  configPath,
  markerPath,
  operatorMarkerPath,
  readyPoolQuery,
} = fleet;

// buildSetGridImage writes the cover to a temp file (it's built to feed the
// marketplace uploaders a path); the social generator only needs to SHOW it in
// the browser, so each cover is moved under public/ and served statically.
// Live-only regenerated output — git-ignored like public/drop-images.
const SOCIAL_COVER_DIR = path.join(__dirname, "..", "public", "noclaim-social");
const SOCIAL_COVER_WEB = "/noclaim-social/";

// One stable cover filename per (bot, account) so refreshing the tab overwrites
// rather than piling up files; the returned URL is cache-busted so the operator
// still sees the freshly regenerated image.
function coverStem(id, login, i) {
  const who =
    String(login || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "") || "acct" + i;
  return "bot" + id + "-" + who;
}

async function publishCover(tmpPath, stem) {
  if (!tmpPath) return ""; // empty set -> buildSetGridImage returns "" -> no cover
  await fsp.mkdir(SOCIAL_COVER_DIR, { recursive: true });
  const file = stem + (path.extname(tmpPath) || ".png");
  // copy + unlink, not rename: os.tmpdir() is often a different mount (EXDEV).
  await fsp.copyFile(tmpPath, path.join(SOCIAL_COVER_DIR, file));
  await fsp.unlink(tmpPath).catch(() => {});
  return SOCIAL_COVER_WEB + file + "?v=" + Date.now();
}

// ---------------------------------------------------------------------------
// No-claim game list (shared with the auto-farmer's exclusion — single source
// of truth). Editable here.
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/games", requireSuperadmin, (req, res) => {
  res.json({ success: true, games: settings.getAutoFarm().noClaimGames || [] });
});

router.post("/api/noclaim-farm/games", requireSuperadmin, async (req, res) => {
  try {
    let games = Array.isArray(req.body.games) ? req.body.games : null;
    if (!games)
      return res
        .status(400)
        .json({ success: false, message: "games must be an array." });
    games = games
      .map((g) => String(g || "").trim().toLowerCase())
      .filter(Boolean);
    const saved = await settings.setAutoFarm({ noClaimGames: games });
    res.json({ success: true, games: saved.noClaimGames });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Auto power (utils/noclaimWatcher.js): the master switch + live status. When
// on, the watcher starts a game's no-claim bots only while a qualifying stream
// is live and stops them otherwise (RAM saver, like the Stream Scout).
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/auto", requireSuperadmin, (req, res) => {
  res.json({
    success: true,
    enabled: !!settings.getAutoFarm().noClaimStreamGate,
    status: noclaimWatcher.status(),
  });
});

router.post("/api/noclaim-farm/auto", requireSuperadmin, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const saved = await settings.setAutoFarm({ noClaimStreamGate: enabled });
    res.json({ success: true, enabled: !!saved.noClaimStreamGate });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Reuse-only game list (World of Tanks / UFL): the auto-farmer may farm these
// but must never spend a FRESH pool account on them — it only reuses accounts
// already used for that same game. Same single-source-of-truth pattern as the
// no-claim list above (see settings.isReuseOnlyGame).
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/reuse-only-games", requireSuperadmin, (req, res) => {
  res.json({
    success: true,
    games: settings.getAutoFarm().reuseOnlyGames || [],
  });
});

router.post(
  "/api/noclaim-farm/reuse-only-games",
  requireSuperadmin,
  async (req, res) => {
    try {
      let games = Array.isArray(req.body.games) ? req.body.games : null;
      if (!games)
        return res
          .status(400)
          .json({ success: false, message: "games must be an array." });
      games = games
        .map((g) => String(g || "").trim().toLowerCase())
        .filter(Boolean);
      const saved = await settings.setAutoFarm({ reuseOnlyGames: games });
      res.json({ success: true, games: saved.reuseOnlyGames });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Pool availability (cheap count for the create form).
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/pool", requireSuperadmin, async (req, res) => {
  try {
    const ready = await AvailableAccount.countDocuments(readyPoolQuery());
    const reserve = settings.getAutoFarm().poolReserve || 0;
    res.json({
      success: true,
      ready,
      reserve,
      spendable: Math.max(0, ready - reserve),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Summary: list bots (cheap — one config sweep + one docker ps).
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/state", requireSuperadmin, async (req, res) => {
  try {
    // Provisioning lock, image presence, per-bot config game + account count,
    // and container states — one round trip.
    const script =
      `prov=no; [ -f ${hosts.shq(BASE + "/.provisioning")} ] && prov=yes; echo "prov=$prov"; ` +
      `img=no; docker image inspect ${hosts.shq(IMAGE)} >/dev/null 2>&1 && img=yes; echo "img=$img"; ` +
      `echo "PS_START"; docker ps -a --filter name=^/${CONTAINER_PREFIX} --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null; echo "PS_END"; ` +
      `echo "BOTS_START"; for d in ${hosts.shq(BOTS_DIR)}/*/Configuration/config.json; do [ -f "$d" ] || continue; ` +
      `id=$(basename $(dirname $(dirname "$d"))); ` +
      `game=$(tr -d '\\n' < "$d" | sed -n 's/.*"FavouriteGames"[^[]*\\[[^"]*"\\([^"]*\\)".*/\\1/p'); ` +
      `n=$(grep -c '"ClientSecret"' "$d"); ` +
      `echo "$id|$game|$n"; done; echo "BOTS_END"`;
    const out = await sh(script, { timeout: 25000 });

    const lines = out.split("\n");
    let section = "";
    const provLine = {};
    const psMap = {};
    const bots = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (line === "PS_START") { section = "ps"; continue; }
      if (line === "PS_END") { section = ""; continue; }
      if (line === "BOTS_START") { section = "bots"; continue; }
      if (line === "BOTS_END") { section = ""; continue; }
      if (line.startsWith("prov=")) { provLine.prov = line.slice(5) === "yes"; continue; }
      if (line.startsWith("img=")) { provLine.img = line.slice(4) === "yes"; continue; }
      if (section === "ps" && line) {
        const [name, state, status] = line.split("|");
        const id = name.replace(CONTAINER_PREFIX, "");
        psMap[id] = { state, status };
      } else if (section === "bots" && line) {
        const [id, game, n] = line.split("|");
        bots.push({ id, game: game || "", accounts: parseInt(n, 10) || 0 });
      }
    }
    for (const b of bots) {
      const ps = psMap[b.id];
      b.containerState = ps ? ps.state : "none";
      b.containerStatus = ps ? ps.status : "";
      b.running = ps ? ps.state === "running" : false;
    }
    bots.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    res.json({
      success: true,
      provisioning: !!provLine.prov,
      imageBuilt: !!provLine.img,
      bots,
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "State failed" });
  }
});

// ---------------------------------------------------------------------------
// Create a bot: claim N ready pool accounts, write its config, run it.
// ---------------------------------------------------------------------------
router.post("/api/noclaim-farm/bots", requireSuperadmin, async (req, res) => {
  try {
    const game = String(req.body.game || "").trim();
    const count = Math.max(1, Math.min(MAX_PER_BOT, parseInt(req.body.count, 10) || 0));
    const out = await fleet.createBot({
      game,
      count,
      actor: actorFromReq(req),
    });
    logEvent({
      category: "noclaim",
      action: "bot_created",
      actor: actorFromReq(req),
      subject: containerFor(out.id),
      game: game || "",
      count: out.claimed,
      detail:
        "no-claim bot " + out.id + " created with " + out.claimed + " account(s)",
    });
    res.json({
      success: true,
      id: out.id,
      claimed: out.claimed,
      message: `Bot ${out.id} created with ${out.claimed} account(s). Building/starting on the Pi — watch the logs.`,
    });
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ success: false, message: err.message || "Create failed" });
  }
});

// ---------------------------------------------------------------------------
// Per-bot accounts (lazy — reads that bot's config from the Pi).
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/accounts",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      if (!raw)
        return res.status(404).json({ success: false, message: "No such bot." });
      const cfg = JSON.parse(raw);
      const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
      // Join back to the pool by clientSecret to recover the login PASSWORD
      // (the config only carries the token). Passwords are stored encrypted in
      // the pool — decrypt here for the operator to list the account manually.
      const secrets = users.map((u) => u.ClientSecret).filter(Boolean);
      const pwMap = new Map();
      const soldMap = new Map();
      const listedMap = new Map();
      if (secrets.length) {
        const rows = await AvailableAccount.find(
          { clientSecret: { $in: secrets } },
          { clientSecret: 1, password: 1, manualSold: 1, listed: 1 },
        ).lean();
        for (const r of rows) {
          let pw = "";
          try {
            pw = r.password ? decrypt(r.password) || "" : "";
          } catch {
            pw = "";
          }
          pwMap.set(r.clientSecret, pw);
          soldMap.set(r.clientSecret, !!r.manualSold);
          listedMap.set(r.clientSecret, !!r.listed);
        }
      }
      // Surface the credentials so the operator can list manually — this whole
      // console is superadmin-only and the token already lives on the Pi.
      const accounts = users.map((u) => ({
        login: u.Login || "",
        twitchId: u.Id || "",
        password: pwMap.get(u.ClientSecret) || "",
        clientSecret: u.ClientSecret || "",
        manualSold: !!soldMap.get(u.ClientSecret),
        listed: !!listedMap.get(u.ClientSecret),
      }));
      res.json({
        success: true,
        game: (cfg.FavouriteGames || [])[0] || "",
        accounts,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Manual "sold" tick — the operator handed this account to a buyer BY HAND.
// The account keeps farming, but the tick is NOT memory-only: an account that
// went to a buyer must come off every listing that still offers it, or the
// platform can hand the same login to a second buyer. So ticking sold also
// runs the unclaimed engine's manual-sold removal right here (delist from
// every active row, park the ledger "removed", clear the listed tick) instead
// of waiting up to a full auto-list pass for the same sweep to notice.
// ---------------------------------------------------------------------------
router.post(
  "/api/noclaim-farm/accounts/:secret/manual-sold",
  requireSuperadmin,
  async (req, res) => {
    try {
      const secret = String(req.params.secret || "").trim();
      if (!secret)
        return res.status(400).json({ success: false, message: "bad secret" });
      const sold = !!req.body.sold;
      const row = await AvailableAccount.findOne(
        { clientSecret: secret },
        { _id: 1, username: 1 },
      ).lean();
      if (!row)
        return res
          .status(404)
          .json({ success: false, message: "No pool account with that secret." });
      await AvailableAccount.updateOne(
        { _id: row._id },
        { $set: { manualSold: sold } },
      );
      let removal = null;
      if (sold) {
        removal = await unclaimedAutoList
          .removeManualSoldOwner({
            poolAccountId: String(row._id),
            actor: actorFromReq(req) || "operator",
          })
          .catch((e) => ({ ledgers: 0, removed: 0, errors: [e.message] }));
        logEvent({
          category: "unclaimed",
          action: "manual_sold",
          actor: actorFromReq(req),
          subject: row.username || String(row._id),
          count: removal.removed || 0,
          detail:
            "manual-sold tick (no-claim) — removed from " +
            (removal.removed || 0) +
            " listing ledger(s)",
        });
      }
      res.json({
        success: true,
        manualSold: sold,
        delisted: removal ? removal.removed : 0,
        delistErrors: removal ? removal.errors : [],
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// Manual "listed" tick — memory only, so the operator can see at a glance
// which accounts are on sale. The account keeps farming; nothing else changes.
router.post(
  "/api/noclaim-farm/accounts/:secret/listed",
  requireSuperadmin,
  async (req, res) => {
    try {
      const secret = String(req.params.secret || "").trim();
      if (!secret)
        return res.status(400).json({ success: false, message: "bad secret" });
      const listed = !!req.body.listed;
      const r = await AvailableAccount.updateOne(
        { clientSecret: secret },
        { $set: { listed } },
      );
      if (!r.matchedCount)
        return res
          .status(404)
          .json({ success: false, message: "No pool account with that secret." });
      res.json({ success: true, listed });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Per-bot live drops (lazy + slow — one Twitch inventory query per account).
// Returns each account's in-progress drops, flagging farmed-but-unclaimed.
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/drops",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      if (!raw)
        return res.status(404).json({ success: false, message: "No such bot." });
      const cfg = JSON.parse(raw);
      const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
      const host = pi();
      // Route the GQL through the Pi host (like the scanners) to keep the
      // fan-out off this server; bounded concurrency keeps it responsive even
      // for a full 70-account bot.
      const CONCURRENCY = 5;
      const out = new Array(users.length);
      let next = 0;
      async function worker() {
        while (next < users.length) {
          const i = next++;
          const u = users[i];
          try {
            const inv = await twitchInventory.fetchInventory(u.ClientSecret, {
              host,
            });
            out[i] = {
              login: u.Login || inv.login,
              ok: true,
              drops: (inv.inProgress || []).map((d) => ({
                name: d.name,
                game: d.game,
                percent: d.percent,
                claimed: d.claimed,
                farmedUnclaimed: d.percent >= 100 && !d.claimed,
              })),
            };
          } catch (e) {
            out[i] = {
              login: u.Login || "",
              ok: false,
              error:
                e && e.code === "token_invalid" ? "token invalid" : e.message,
            };
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker),
      );
      res.json({ success: true, accounts: out });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Per-bot social posts (lazy + slow — one Twitch inventory query per account).
// For each account it turns the SELLABLE unclaimed drops into ready-to-paste
// post copy + a grid cover image, for the operator to review and post BY HAND.
// GENERATION ONLY: nothing here posts to X / Reddit / Discord / anywhere.
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/social",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      if (!raw)
        return res.status(404).json({ success: false, message: "No such bot." });
      const cfg = JSON.parse(raw);
      const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
      const cfgGame = (cfg.FavouriteGames || [])[0] || "";
      const host = pi();
      // Same bounded fan-out as /drops (one GQL call per account, egressing via
      // the Pi) so a full 70-account bot still responds.
      const CONCURRENCY = 5;
      const out = new Array(users.length);
      let next = 0;
      async function worker() {
        while (next < users.length) {
          const i = next++;
          const u = users[i];
          try {
            const inv = await twitchInventory.fetchInventory(u.ClientSecret, {
              host,
            });
            // What's sellable on a NO-CLAIM account, from two places:
            //  1. inProgress drops the bot farmed to 100% but left UNCLAIMED
            //     (percent>=100 && !claimed) — the core no-claim product, the
            //     same items the Drops tab flags as farmedUnclaimed. These live
            //     in inProgress, NOT drops[] (they were never claimed, so
            //     buildDrops never sees them).
            //  2. awarded event drops still needing the buyer to connect
            //     (drops[] state==="connect") — games whose drops land here
            //     instead. "connected"/"claimed" are already spoken for.
            // Merge both, deduped by item name (an item can appear in one or the
            // other), so the post/cover advertise the account's actual holdings.
            const sellable = [];
            const seen = new Set();
            const add = (name, image, qty, g) => {
              const key = String(name || "")
                .trim()
                .toLowerCase();
              if (!key || seen.has(key)) return;
              seen.add(key);
              sellable.push({ name, image, qty: Math.max(1, qty || 1), game: g });
            };
            (inv.drops || [])
              .filter((d) => d.state === "connect")
              .forEach((d) => add(d.name, d.imageURL, d.count, d.game));
            (inv.inProgress || [])
              .filter((d) => d.percent >= 100 && !d.claimed)
              .forEach((d) => add(d.name, d.imageURL, 1, d.game));
            const game = (sellable[0] && sellable[0].game) || cfgGame;
            const login = u.Login || inv.login || "";
            const post = buildSocialPost({
              game,
              items: sellable.map((s) => ({ name: s.name, count: s.qty })),
            });
            // Reuse the marketplace cover renderer as-is, then move the temp
            // file under public/ so the UI can <img> it. Empty set -> "" cover,
            // which the UI simply omits.
            const coverUrl = await publishCover(
              await buildSetGridImage({
                items: sellable.map((s) => ({
                  name: s.name,
                  image: s.image,
                  qty: s.qty,
                })),
              }),
              coverStem(id, login, i),
            );
            out[i] = { login, ok: true, game, count: sellable.length, post, coverUrl };
          } catch (e) {
            out[i] = {
              login: u.Login || "",
              ok: false,
              error:
                e && e.code === "token_invalid" ? "token invalid" : e.message,
            };
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker),
      );
      res.json({ success: true, accounts: out });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Container logs for one bot.
// ---------------------------------------------------------------------------
router.get(
  "/api/noclaim-farm/bots/:id/logs",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      const tail = Math.max(20, Math.min(1000, parseInt(req.query.tail, 10) || 200));
      let container = "";
      try {
        container = await hosts.dockerLogs(pi(), containerFor(id), { tail });
      } catch (e) {
        container = "(no logs: " + (e.message || "") + ")";
      }
      const provision = await sh(
        `[ -f ${hosts.shq(BASE + "/provision.log")} ] && tail -n 60 ${hosts.shq(BASE + "/provision.log")} || true`,
        { timeout: 15000 },
      );
      res.json({ success: true, container, provision });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Stop a bot's container (keeps config + accounts claimed).
// ---------------------------------------------------------------------------
router.post(
  "/api/noclaim-farm/bots/:id/stop",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      // Mark it operator-off so the auto-power watcher won't cold-start it back
      // on the next live event — an explicit Stop stays stopped until Restart.
      await sh(
        `docker stop ${hosts.shq(containerFor(id))} 2>/dev/null || true; ` +
          `touch ${hosts.shq(operatorMarkerPath(id))} 2>/dev/null || true`,
        { timeout: 25000 },
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Restart a bot's container. Works whether it's running or was stopped:
// `docker restart` re-spins the process from scratch, which respawns every
// per-account watch thread. Over days of uptime a container can silently bleed
// watch threads (some accounts stop farming while others keep going) — a
// restart revives them all, and it also just starts a container the operator
// had stopped. Watch progress lives on Twitch's side, so nothing is lost.
// ---------------------------------------------------------------------------
router.post(
  "/api/noclaim-farm/bots/:id/restart",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      // `docker restart` errors if the container doesn't exist; surface that
      // clearly rather than silently swallowing it, so the UI can tell the
      // operator to re-create the bot (its container may have been removed).
      // Clear both auto-power markers: a manual Restart means the operator is
      // taking control, so the watcher manages this bot fresh from here (neither
      // "parked by me" nor "operator-off" applies once they restart it).
      const out = await sh(
        `rm -f ${hosts.shq(markerPath(id))} ${hosts.shq(operatorMarkerPath(id))} 2>/dev/null || true; ` +
          `docker restart ${hosts.shq(containerFor(id))} 2>&1 || echo "__ERR__"`,
        { timeout: 40000 },
      );
      if (out.includes("__ERR__"))
        return res.status(409).json({
          success: false,
          message:
            "No container to restart — it may have been removed. Release and re-create the bot.",
        });
      logEvent({
        category: "noclaim",
        action: "bot_restarted",
        actor: actorFromReq(req),
        subject: containerFor(id),
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// Release a bot: stop+remove container, release its accounts back to the pool,
// delete its config. Use once you've listed the accounts (or to abandon).
// ---------------------------------------------------------------------------
router.post(
  "/api/noclaim-farm/bots/:id/release",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.params.id).replace(/[^0-9]/g, "");
      if (!id) return res.status(400).json({ success: false, message: "bad id" });
      // Read the config to recover which pool accounts to release.
      const raw = await sh(
        `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
        { timeout: 15000 },
      );
      let released = 0;
      if (raw) {
        const cfg = JSON.parse(raw);
        const secrets = (
          (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) ||
          []
        )
          .map((u) => u.ClientSecret)
          .filter(Boolean);
        if (secrets.length) {
          const r = await AvailableAccount.updateMany(
            { clientSecret: { $in: secrets } },
            {
              $set: { status: "available", claimedAt: null, claimedNote: "" },
            },
          );
          released = r.modifiedCount || 0;
          if (released) {
            const rows = await AvailableAccount.find({ clientSecret: { $in: secrets } }, { _id: 1 }).lean();
            await recordPoolUsage(rows.map((row) => row._id), { event: "released", actor: "noclaim" });
          }
        }
      }
      await sh(
        `docker rm -f ${hosts.shq(containerFor(id))} >/dev/null 2>&1 || true; rm -rf ${hosts.shq(botDir(id))}`,
        { timeout: 25000 },
      );
      logEvent({
        category: "noclaim",
        action: "bot_released",
        actor: actorFromReq(req),
        subject: containerFor(id),
        count: released,
        detail: "released " + released + " account(s) back to the pool",
      });
      res.json({ success: true, released });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ===========================================================================
// SPENT accounts (sold / connected) — scan, remove, and view.
//
// Some accounts sitting in a no-claim bot are no longer worth farming:
//   * SOLD — the account was delivered to a buyer (Shop / reseller / bulk, or a
//     recycled sold-game marker). Detected from the account DB by clientSecret.
// CONNECTED is NOT a spend signal and no longer flags anything. It was, and it
// was wrong: `isAccountConnected` only says the Twitch login is linked to a
// Battle.net / Ubisoft account, which every account that ever farmed on a
// CLAIMING bot carries forever. A linked account still accumulates
// 100%-watched UNCLAIMED drops — exactly what this farm sells. Flagging on the
// link pulled 153 good accounts out of their bots (Sept 2026); 63 of them had
// never been sold through any channel and were returned to the pool. The live
// link + stock counts are still reported per row so the operator can see them,
// but only a recorded sale puts an account on the removal list.
//
// The operator scans a bot, reviews the flagged accounts, then removes them.
// Removal rewrites the bot's config WITHOUT them and restarts the container
// (or stops it if none are left), then logs each into NoclaimSpentAccount so
// the page's "Spent" view keeps a history. Per the operator's choice this does
// NOT touch the pool / BotAccount rows — the accounts simply stop being farmed
// here and are left for the global Spent-accounts tab to recycle manually.
// ===========================================================================

// Which games this account is CONNECTED for, normalised. `connected` is the
// campaign-level `isAccountConnected` — the Twitch account is linked to a game
// account, so that game's drops land on someone else's profile.
function connectedGamesFor(inv) {
  const out = new Set();
  for (const d of (inv && inv.inProgress) || [])
    if (d.connected && d.game) out.add(settings.normGameName(d.game));
  for (const d of (inv && inv.drops) || [])
    if (d.connected && d.game) out.add(settings.normGameName(d.game));
  out.delete("");
  return [...out];
}

// Is one of those connected games the game this bot farms? Substring semantics
// like soldGameExclusion, so a bot on "rainbow six" matches a connection
// recorded as "rainbow six siege". A connection for a DIFFERENT game says
// nothing about this game's drops — an account linked for Escape from Tarkov
// still has its Overwatch drops undelivered — so it must not read as spent
// here. With no FavouriteGame to scope by, any connection counts (old rule).
function connectedForGame(connGames, game) {
  const g = settings.normGameName(game);
  if (!g) return connGames.length > 0;
  return connGames.some((c) => c.includes(g) || g.includes(c));
}

// How many 100%-watched UNCLAIMED drops this account holds for the bot's game
// — the exact thing the unclaimed auto-lister sells (sellableDropsFromNoClaimInv).
// Anything above zero means the account is live stock, whatever its link says.
function sellableForGame(inv, game) {
  const g = settings.normGameName(game);
  let n = 0;
  for (const d of (inv && inv.inProgress) || []) {
    if (d.claimed || !(d.percent >= 100)) continue;
    const dg = settings.normGameName(d.game);
    if (!g || !dg || dg.includes(g) || g.includes(dg)) n++;
  }
  return n;
}

async function readConfigRaw(id) {
  return await sh(
    `[ -f ${hosts.shq(configPath(id))} ] && cat ${hosts.shq(configPath(id))} || echo ''`,
    { timeout: 15000 },
  );
}

// Which of the given clientSecrets belong to accounts already sold, keyed by
// clientSecret. A BotAccount sale marker (shop / reseller / bulk) wins over a
// pool-row marker; a pool row with soldGames set means it previously delivered
// that game.
async function soldMapForSecrets(secrets) {
  const map = new Map();
  const uniq = [...new Set((secrets || []).filter(Boolean))];
  if (!uniq.length) return map;
  const [bots, pool] = await Promise.all([
    BotAccount.find(
      { clientSecret: { $in: uniq } },
      { clientSecret: 1, soldAt: 1, soldBulkOrderId: 1, resellerId: 1 },
    ).lean(),
    AvailableAccount.find(
      { clientSecret: { $in: uniq } },
      { clientSecret: 1, soldGames: 1, claimedNote: 1 },
    ).lean(),
  ]);
  for (const b of bots) {
    let why = "";
    if (b.soldAt) why = "shop sale";
    else if (b.resellerId) why = "reseller";
    else if (b.soldBulkOrderId) why = "bulk order";
    if (why) map.set(b.clientSecret, { sold: true, why });
  }
  for (const p of pool) {
    if (map.has(p.clientSecret)) continue; // BotAccount signal already wins
    if (Array.isArray(p.soldGames) && p.soldGames.length) {
      // NOT proof of a sale: a previous spent sweep stamps soldGames for a
      // CONNECTED account too. Say "spent", not "sold", so the operator is not
      // told a sale happened that never did.
      map.set(p.clientSecret, { sold: true, why: "already spent (" + p.soldGames.join(", ") + ")" });
    } else if (/^sold/i.test(String(p.claimedNote || ""))) {
      map.set(p.clientSecret, { sold: true, why: "pool note says sold" });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Scan ONE bot for spent accounts (sold via DB + connected via live Twitch).
// Scoped to one bot per call — a Twitch query per account — so the page can
// sweep the fleet bot-by-bot without a single giant, timeout-prone request.
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/spent/scan", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.query.botId || "").replace(/[^0-9]/g, "");
    if (!id) return res.status(400).json({ success: false, message: "botId required" });
    const raw = await readConfigRaw(id);
    if (!raw) return res.status(404).json({ success: false, message: "No such bot." });
    const cfg = JSON.parse(raw);
    const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
    const game = (cfg.FavouriteGames || [])[0] || "";
    const sold = await soldMapForSecrets(users.map((u) => u.ClientSecret));

    // Live connected/token check, one GQL per account, egressing via the Pi
    // with bounded concurrency (same fan-out as the Drops tab).
    const host = pi();
    const CONCURRENCY = 5;
    const live = new Array(users.length);
    let next = 0;
    async function worker() {
      while (next < users.length) {
        const i = next++;
        const u = users[i];
        try {
          const inv = await twitchInventory.fetchInventory(u.ClientSecret, { host });
          const connGames = connectedGamesFor(inv);
          live[i] = {
            connected: connectedForGame(connGames, game),
            connectedGames: connGames,
            sellable: sellableForGame(inv, game),
            tokenStatus: "ok",
            tokenError: "",
          };
        } catch (e) {
          live[i] = {
            connected: false,
            connectedGames: [],
            sellable: 0,
            tokenStatus: e && e.code ? e.code : "error",
            tokenError: (e && e.message) || "error",
          };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, users.length) }, worker),
    );

    const spent = [];
    users.forEach((u, i) => {
      const s = sold.get(u.ClientSecret) || { sold: false, why: "" };
      const l = live[i] || {};
      if (!s.sold) return;
      spent.push({
        clientSecret: u.ClientSecret || "",
        login: u.Login || "",
        twitchId: u.Id || "",
        sold: !!s.sold,
        soldWhy: s.why || "",
        connected: !!l.connected,
        connectedGames: l.connectedGames || [],
        sellable: l.sellable || 0,
        tokenStatus: l.tokenStatus || "",
        tokenError: l.tokenError || "",
      });
    });
    res.json({
      success: true,
      botId: id,
      game,
      scanned: users.length,
      spent,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Remove selected spent accounts from ONE bot: rewrite the config without them,
// restart the container (or stop it if none remain), and log each into the
// spent view. Does NOT modify pool / BotAccount rows (operator's choice).
// Body: { botId, accounts: [{ clientSecret, login, twitchId, sold, soldWhy,
//         connected, tokenStatus }] } — the rows from a scan.
// ---------------------------------------------------------------------------
router.post("/api/noclaim-farm/spent/remove", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.body.botId || "").replace(/[^0-9]/g, "");
    if (!id) return res.status(400).json({ success: false, message: "botId required" });
    const picked = Array.isArray(req.body.accounts) ? req.body.accounts : [];
    const bySecret = new Map();
    for (const a of picked) {
      const cs = String((a && a.clientSecret) || "");
      if (cs) bySecret.set(cs, a);
    }
    if (!bySecret.size)
      return res.status(400).json({ success: false, message: "No accounts selected." });

    const raw = await readConfigRaw(id);
    if (!raw) return res.status(404).json({ success: false, message: "No such bot." });
    const cfg = JSON.parse(raw);
    const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
    const game = (cfg.FavouriteGames || [])[0] || "";

    const removed = users.filter((u) => bySecret.has(u.ClientSecret));
    if (!removed.length)
      return res
        .status(409)
        .json({ success: false, message: "None of those accounts are on this bot." });
    const kept = users.filter((u) => !bySecret.has(u.ClientSecret));

    // Authoritative sold reason from the DB (the client-supplied flags are only
    // a fallback for the connected/token detail the DB doesn't hold).
    const sold = await soldMapForSecrets(removed.map((u) => u.ClientSecret));

    // Rewrite the config without the removed users, keeping every other field.
    // No-claim containers run --user 0:0, so the config stays chmod 600 (a 644
    // here would be the wrong direction — see the migration notes).
    cfg.TwitchSettings.TwitchUsers = kept;
    const newRaw = JSON.stringify(cfg, null, 2);
    await sh(
      `cat > ${hosts.shq(configPath(id))} && chmod 600 ${hosts.shq(configPath(id))}`,
      { timeout: 20000, input: newRaw },
    );

    // Restart so the container drops the removed accounts' watch threads; if the
    // bot is now empty, stop it (a 0-account config just tight-loops).
    let action;
    if (kept.length > 0) {
      await sh(`docker restart ${hosts.shq(containerFor(id))} 2>/dev/null || true`, {
        timeout: 40000,
      });
      action = "restarted";
    } else {
      await sh(`docker stop ${hosts.shq(containerFor(id))} 2>/dev/null || true`, {
        timeout: 25000,
      });
      action = "stopped";
    }

    // Log each removal into the spent view (one row per login; a re-sweep
    // refreshes it rather than duplicating).
    const actor = actorFromReq(req);
    const at = new Date();
    for (const u of removed) {
      const meta = bySecret.get(u.ClientSecret) || {};
      const s = sold.get(u.ClientSecret) || { sold: false, why: "" };
      const loginLower = String(u.Login || "").toLowerCase();
      await NoclaimSpentAccount.updateOne(
        loginLower
          ? { loginLower }
          : { twitchId: String(u.Id || ""), login: u.Login || "" },
        {
          $set: {
            login: u.Login || "",
            loginLower,
            twitchId: String(u.Id || ""),
            game,
            botId: id,
            container: containerFor(id),
            sold: !!(s.sold || meta.sold),
            connected: !!meta.connected,
            soldWhy: s.why || meta.soldWhy || "",
            tokenStatus: meta.tokenStatus || "",
            actor,
            sweptAt: at,
          },
        },
        { upsert: true },
      );
    }

    // Send the removed accounts onward to the global Spent-accounts (recycle)
    // tab: stamp the pool row with the game + a "spent" note so
    // gatherSpentAccounts() lists them there, where the recycler can rescan the
    // pool token directly (no-claim accounts have no BotAccount to rescan
    // with). Status STAYS claimed — nothing re-farms them here or in the
    // auto-farmer until the operator recycles them from that tab.
    const secrets = removed.map((u) => u.ClientSecret).filter(Boolean);
    if (secrets.length) {
      const rows = await AvailableAccount.find(
        { clientSecret: { $in: secrets } },
        { clientSecret: 1, soldGames: 1 },
      ).lean();
      const rowBySecret = new Map(rows.map((r) => [r.clientSecret, r]));
      const stampGame = settings.normGameName(game);
      const writes = [];
      const stampedIds = [];
      for (const u of removed) {
        const r = rowBySecret.get(u.ClientSecret);
        if (!r) continue;
        const games = new Set(
          (Array.isArray(r.soldGames) ? r.soldGames : []).filter(Boolean),
        );
        if (stampGame) games.add(stampGame);
        writes.push({
          updateOne: {
            filter: { _id: r._id, status: "claimed" },
            update: {
              $set: {
                claimedNote: "spent — no-claim removed " + (game || ""),
                soldGames: [...games],
              },
            },
          },
        });
        stampedIds.push(r._id);
      }
      if (writes.length) {
        await AvailableAccount.bulkWrite(writes);
        await recordPoolUsage(stampedIds, {
          event: "spent",
          actor: actorFromReq(req),
          note: "spent — no-claim removed (awaiting recycle)",
          game: stampGame || "",
        });
      }
    }
    logEvent({
      category: "noclaim",
      action: "spent_removed",
      actor,
      subject: containerFor(id),
      game: game || "",
      count: removed.length,
      detail:
        "removed " +
        removed.length +
        " spent (sold/connected) account(s) from no-claim bot " +
        id,
    });
    res.json({ success: true, removed: removed.length, remaining: kept.length, action });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// The spent view: everything removed so far (history), newest first.
// ---------------------------------------------------------------------------
router.get("/api/noclaim-farm/spent/list", requireSuperadmin, async (req, res) => {
  try {
    const rows = await NoclaimSpentAccount.find(
      {},
      {
        login: 1,
        twitchId: 1,
        game: 1,
        botId: 1,
        container: 1,
        sold: 1,
        connected: 1,
        soldWhy: 1,
        tokenStatus: 1,
        sweptAt: 1,
      },
    )
      .sort({ sweptAt: -1 })
      .limit(500)
      .lean();
    res.json({ success: true, accounts: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Dismiss one row from the spent view (or all of them). Purely a UI cleanup —
// it removes the history record, not any account.
router.delete("/api/noclaim-farm/spent/:id", requireSuperadmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (id === "all") {
      const r = await NoclaimSpentAccount.deleteMany({});
      return res.json({ success: true, deleted: r.deletedCount || 0 });
    }
    if (!/^[a-f0-9]{24}$/i.test(id))
      return res.status(400).json({ success: false, message: "bad id" });
    await NoclaimSpentAccount.deleteOne({ _id: id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
