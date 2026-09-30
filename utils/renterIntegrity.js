// Renter / rent-farm integrity check (2026-10-01).
//
// The 09-29 "is Overwatch farming?" audit was a one-off scratch script; the
// problems it found (two paid buyers with dead tokens for days, wrong-game
// placements, an expired renter still in a running bot) had raised no alert,
// because nothing compared the ledger with the configs. This does, on the
// capacity watcher's tick, at most hourly:
//   deadToken      a LIVE window whose token the scanner reports invalid
//   notFarming     a live account of an ACTIVE renter / paid window that is
//                  enabled in NO config on its host
//   farmingPastEnd an account whose window lapsed, or whose renter is expired
//                  or suspended, still enabled in a config that is running
//   double         one token enabled in two configs
//   wrongGame      a rent-farm buyer's account pinned to games that do not
//                  include the game its order sold
// Reads ONE batched config listing per host that carries a rental stack (the
// Pi and the no-claim tree are fleetIntegrity's job). A finding pages only
// after it is seen on two checks in a row (a sale landing between the ledger
// read and the config read is not a defect), then reminds daily; one line says
// when everything is clear again. Read-only: it never edits anything.
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 55 * 60 * 1000;
const LIST_MAX = 15;

const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;

let deps = {};
const REAL = {
  hosts: () => require("./botHosts"),
  listStacks: () => require("./renterBotStacks").listStacks(),
  RenterAccount: () => require("../models/RenterAccount"),
  Renter: () => require("../models/Renter"),
  FarmServiceOrder: () => require("../models/FarmServiceOrder"),
  sendTelegram: (m) => require("./telegram").sendTelegram(m),
  logEvent: (e) => require("./systemLog").logEvent(e),
  now: () => Date.now(),
};
function dep(name) {
  return Object.prototype.hasOwnProperty.call(deps, name) ? deps[name] : REAL[name];
}

const lower = (s) => String(s || "").trim().toLowerCase();
function usersOf(cfg) {
  const u = cfg && cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers;
  return Array.isArray(u) ? u : [];
}
function isEnabled(u) {
  return !!(u && u.ClientSecret) && u.Enabled !== false && u.enabled !== false;
}
function blocked(r, now) {
  return !r || r.status === "suspended" || (r.accessEnd && new Date(r.accessEnd).getTime() <= now);
}

// Pure: everything the checks need, in → findings out (unit-tested).
//   homes:   [{ host, file, running, cfg }]
//   live:    RenterAccount rows with farmEndedAt null (enabled)
//   ended:   RenterAccount rows with farmEndedAt set
//   renters: Map(id -> renter), holderId, orders: Map(lowerLogin -> order)
function classify({ homes, live, ended, renters, holderId, orders, now }) {
  const where = new Map(); // secret -> [{ key, running, games }]
  for (const h of homes) {
    for (const u of usersOf(h.cfg)) {
      if (!isEnabled(u)) continue;
      const s = String(u.ClientSecret);
      if (!where.has(s)) where.set(s, []);
      where.get(s).push({
        key: h.host + "/" + h.file,
        host: h.host,
        running: h.running,
        games: Array.isArray(u.FavouriteGames) ? u.FavouriteGames.filter(Boolean) : [],
      });
    }
  }
  const scannedHosts = new Set(homes.map((h) => h.host));
  const findings = [];
  const add = (kind, row, detail) =>
    findings.push({ kind, id: kind + ":" + row.clientSecret, login: row.login || "", renter: String(row.renter), detail });

  for (const a of live) {
    const r = renters.get(String(a.renter));
    const isHolder = String(a.renter) === String(holderId);
    const homesOf = where.get(String(a.clientSecret)) || [];
    const windowLive = !a.farmUntil || new Date(a.farmUntil).getTime() > now;
    if (!windowLive) continue; // renterExpiry's business (and it alerts when stuck)
    if (a.lastScanStatus === "token_invalid") {
      add("deadToken", a, "the scanner reports its token invalid (password changed?)");
    }
    const ownerBlocked = !isHolder && blocked(r, now);
    const ownerStopped = !isHolder && r && r.botStoppedAt;
    if (ownerBlocked) {
      const running = homesOf.filter((x) => x.running !== false);
      if (running.length) {
        add("farmingPastEnd", a, "renter " + ((r && r.username) || "?") + " is " +
          (r && r.status === "suspended" ? "suspended" : "past its lease") + " but it farms in " +
          running.map((x) => x.key).join(", "));
      }
      continue;
    }
    if (!homesOf.length && !ownerStopped && a.configFile && scannedHosts.has(String(a.host || "local"))) {
      add("notFarming", a, "enabled in no config on " + (a.host || "local") + " (ledger says " + a.configFile + ")");
    }
    if (homesOf.length > 1) {
      add("double", a, "enabled in " + homesOf.map((x) => x.key).join(" AND "));
    }
    if (isHolder && homesOf.length) {
      const o = orders.get(lower(a.login));
      if (o && o.game) {
        const bad = homesOf.filter((x) => x.games.length && !x.games.some((g) => lower(g) === lower(o.game)));
        if (bad.length) {
          add("wrongGame", a, "its order is " + o.game + " but it is pinned to " +
            bad[0].games.join(", ") + " in " + bad[0].key);
        }
      }
    }
  }
  for (const a of ended) {
    const running = (where.get(String(a.clientSecret)) || []).filter((x) => x.running !== false);
    if (running.length) {
      add("farmingPastEnd", a, "its window ended but it still farms in " + running.map((x) => x.key).join(", "));
    }
  }
  return findings;
}

// IO: read the ledger and every config on the hosts that carry rental stacks.
async function gather() {
  const hosts = dep("hosts")();
  const now = dep("now")();
  const stacks = await dep("listStacks")();
  const hostIds = [...new Set((stacks || []).map((s) => String(s.host || "local")))];
  const homes = [];
  const unreadable = [];
  for (const hid of hostIds) {
    const host = hosts.resolveHost(hid);
    if (!host) {
      unreadable.push(hid + ": unknown host");
      continue;
    }
    let files;
    let read;
    let states = null;
    try {
      files = (await hosts.readdir(host, { retries: 1 })).filter((f) => CONFIG_RE.test(f));
      read = await hosts.readFiles(host, files);
      states = await hosts.dockerPs(host).catch(() => null);
    } catch (e) {
      unreadable.push(hid + ": " + String((e && e.message) || e).slice(0, 120));
      continue;
    }
    for (const f of files) {
      const r = read[f];
      let cfg = null;
      if (r && r.ok && r.text) {
        try {
          cfg = JSON.parse(r.text);
        } catch {
          cfg = null;
        }
      }
      if (!cfg) {
        if (!(r && /not found/i.test(String(r.error || "")))) unreadable.push(hid + "/" + f);
        continue;
      }
      const m = f.match(/^config_0*(\d+)\.json$/);
      const container = m ? "twitchbotx" + parseInt(m[1], 10) : f === "config.json" ? "twitchbot" : null;
      const st = states && container ? states[container] : null;
      homes.push({
        host: hid,
        file: f,
        running: states ? !!(st && /^running/i.test(String(st.state || ""))) : null,
        cfg,
      });
    }
  }
  const RenterAccount = dep("RenterAccount")();
  const Renter = dep("Renter")();
  const FarmServiceOrder = dep("FarmServiceOrder")();
  const since = new Date(now - 30 * DAY_MS);
  const [live, ended, renterRows] = await Promise.all([
    RenterAccount.find(
      { enabled: true, farmEndedAt: null },
      { renter: 1, clientSecret: 1, login: 1, host: 1, configFile: 1, lastScanStatus: 1, farmUntil: 1 },
    ).lean(),
    // Ended recently: an old ended row whose buyer re-added it by hand
    // somewhere is not ours to judge after a month.
    RenterAccount.find(
      { farmEndedAt: { $gte: since } },
      { renter: 1, clientSecret: 1, login: 1 },
    ).lean(),
    Renter.find({}, { username: 1, usernameLower: 1, status: 1, accessEnd: 1, botStoppedAt: 1 }).lean(),
  ]);
  const renters = new Map(renterRows.map((r) => [String(r._id), r]));
  const holder = renterRows.find((r) => lower(r.usernameLower || r.username) === "operator-selffarm");
  const holderId = holder ? String(holder._id) : null;
  const holderLogins = live.filter((a) => String(a.renter) === holderId).map((a) => a.login).filter(Boolean);
  const orderRows = holderLogins.length
    ? await FarmServiceOrder.find(
        { "accounts.login": { $in: [...new Set([...holderLogins, ...holderLogins.map(lower)])] } },
        { orderId: 1, market: 1, buyerUsername: 1, game: 1, "accounts.login": 1 },
      ).lean()
    : [];
  const orders = new Map();
  for (const o of orderRows) for (const x of o.accounts || []) orders.set(lower(x.login), o);
  return { homes, live, ended, renters, holderId, orders, now, unreadable };
}

// Latches: finding id -> { seen: consecutive checks, pagedAt }
const seen = new Map();
let lastRunAt = 0;
let lastHadFindings = false;

async function checkOnce({ notify = true, force = false } = {}) {
  const now = dep("now")();
  if (!force && now - lastRunAt < MIN_INTERVAL_MS) return null;
  lastRunAt = now;
  const g = await gather();
  const findings = classify(g);
  const ids = new Set(findings.map((f) => f.id));
  for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id);
  const toPage = [];
  for (const f of findings) {
    const s = seen.get(f.id) || { seen: 0, pagedAt: 0 };
    s.seen += 1;
    if (s.seen >= 2 && (!s.pagedAt || now - s.pagedAt >= DAY_MS)) {
      toPage.push(f);
      if (notify) s.pagedAt = now;
    }
    seen.set(f.id, s);
  }
  if (notify && toPage.length) {
    const orderOf = (f) => g.orders.get(lower(f.login));
    const who = (f) => {
      const o = orderOf(f);
      if (o) return (o.market || "?") + " order " + String(o.orderId || "").slice(0, 8) + (o.buyerUsername ? " (" + o.buyerUsername + ")" : "");
      const r = g.renters.get(f.renter);
      return "renter " + ((r && r.username) || "?");
    };
    const labels = {
      deadToken: "dead token",
      notFarming: "not in any bot",
      farmingPastEnd: "farming past its end",
      double: "in two bots",
      wrongGame: "wrong game",
    };
    await dep("sendTelegram")(
      "🔎 Renter / rent-farm integrity: " + toPage.length + " problem(s)\n" +
        toPage
          .slice(0, LIST_MAX)
          .map((f) => "• " + labels[f.kind] + ": " + f.login + " — " + who(f) + " — " + f.detail)
          .join("\n") +
        (toPage.length > LIST_MAX ? "\n… and " + (toPage.length - LIST_MAX) + " more" : "") +
        (g.unreadable.length ? "\n(not read: " + g.unreadable.slice(0, 5).join(", ") + ")" : ""),
    ).catch((e) => console.error("renterIntegrity telegram failed:", e.message));
    try {
      dep("logEvent")({
        category: "renter",
        action: "renter_integrity_findings",
        actor: "renterIntegrity",
        severity: "warn",
        count: toPage.length,
        detail: toPage.map((f) => f.kind + ":" + f.login).join(", ").slice(0, 480),
      });
    } catch {
      /* diagnostics only */
    }
  }
  if (notify && lastHadFindings && !findings.length) {
    await dep("sendTelegram")("✅ Renter / rent-farm integrity: no problems left.").catch(() => {});
  }
  if (notify) lastHadFindings = findings.length > 0;
  return { findings, paged: toPage.map((f) => f.id), unreadable: g.unreadable };
}

module.exports = {
  classify,
  gather,
  checkOnce,
  __setDeps: (d) => {
    deps = { ...deps, ...(d || {}) };
  },
  _reset: () => {
    deps = {};
    seen.clear();
    lastRunAt = 0;
    lastHadFindings = false;
  },
};
