// One account, one bot — across EVERY bot system (owner, 2026-09-28).
//
// dupeGuard keeps an account in one regular config per host, and nothing more:
// it never looks at another host's configs, and never at the no-claim farm's
// own tree. So a login can farm in a regular (or renter) bot and a no-claim
// bot at the same time — 32 accounts sat in two bots at once for 54 hours from
// 2026-09-25, which is how the auto-farm ended up claiming drops that were on
// sale unclaimed. Every other system trusts the pool row; only the config
// files say where an account really farms.
//
// This reads every config file on every host (one batched read per host) plus
// every no-claim bot config, and reports each ClientSecret that is ENABLED in
// more than one of them. Read-only: it never edits a config — which copy is
// the wrong one is a decision for a person.
const hosts = require("./botHosts");

// The regular bot configs in a host's bot dir (config.json, config_14.json,
// config_rent-3.json ...), the same shape dupeGuard and the Bots page read.
const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;

function usersOf(cfg) {
  const list = cfg && cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers;
  return Array.isArray(list) ? list : [];
}

// A user entry farms unless it is explicitly switched off.
function enabled(u) {
  return !!(u && u.ClientSecret) && u.Enabled !== false && u.enabled !== false;
}

// Pure: homes = [{ where, cfg }] -> the ClientSecrets enabled in 2+ of them.
// A secret listed twice in ONE config is that config's own problem (dupeGuard
// territory) and is counted once here.
function findCollisions(homes) {
  const bySecret = new Map();
  for (const h of homes || []) {
    for (const u of usersOf(h.cfg)) {
      if (!enabled(u)) continue;
      const s = String(u.ClientSecret);
      if (!bySecret.has(s)) bySecret.set(s, { login: String(u.Login || ""), where: new Set() });
      bySecret.get(s).where.add(h.where);
    }
  }
  const out = [];
  let accounts = 0;
  for (const [secret, e] of bySecret) {
    accounts++;
    if (e.where.size < 2) continue;
    out.push({
      login: e.login,
      // Enough to find it again, never the credential itself.
      secretTail: "…" + secret.slice(-4),
      homes: [...e.where].sort(),
    });
  }
  out.sort((a, b) => b.homes.length - a.homes.length || a.login.localeCompare(b.login));
  return { accounts, collisions: out };
}

// Read every config. `unreadable` lists what could not be read: an account in
// such a config may collide too, so a clean result with unreadable configs is
// not proof.
async function readAllHomes() {
  const homes = [];
  const unreadable = [];
  for (const h of hosts.listHosts()) {
    const host = hosts.resolveHost(h.id);
    if (!host) continue;
    let files;
    try {
      files = (await hosts.readdir(host, { retries: 1 })).filter((f) => CONFIG_RE.test(f));
    } catch (e) {
      unreadable.push(h.id + ": " + String((e && e.message) || e).slice(0, 120));
      continue;
    }
    let read = {};
    try {
      read = await hosts.readFiles(host, files);
    } catch (e) {
      unreadable.push(h.id + ": " + String((e && e.message) || e).slice(0, 120));
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
        unreadable.push(h.id + "/" + f);
        continue;
      }
      homes.push({ where: h.id + "/" + f, cfg });
    }
  }
  try {
    const nc = await require("./unclaimedAutoList").readNoClaimConfigs();
    if (!nc.length) unreadable.push("no-claim: no configs listed");
    for (const c of nc) {
      if (!c.cfg) {
        unreadable.push("no-claim bot " + c.id);
        continue;
      }
      homes.push({ where: "no-claim bot " + c.id, cfg: c.cfg });
    }
  } catch (e) {
    unreadable.push("no-claim: " + String((e && e.message) || e).slice(0, 120));
  }
  return { homes, unreadable };
}

async function oneAccountOneBot() {
  const { homes, unreadable } = await readAllHomes();
  const { accounts, collisions } = findCollisions(homes);
  return { at: new Date(), configs: homes.length, accounts, collisions, unreadable };
}

module.exports = { CONFIG_RE, findCollisions, readAllHomes, oneAccountOneBot };
