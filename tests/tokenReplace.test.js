// Replacing a dead token on an existing account (utils/tokenReplace.js). The
// properties that matter: nothing is written unless the new token is proven to
// be that account's and to pass integrity; every place the account lives gets
// the new token; only running bots whose config changed restart; the token is
// never echoed. Driven end to end against in-memory fakes — no Twitch, no SSH.
const test = require("node:test");
const assert = require("node:assert");

const tr = require("../utils/tokenReplace");

const TOK = "t0kenaaaaabbbbbcccccdddddeeeee"; // synthetic, token-shaped
const TOK2 = "t0kenfffffggggghhhhhiiiiijjjjj";

// ---- parsing -------------------------------------------------------------

test("two JSON arrays pasted back to back (the token fetcher's output) are both read", () => {
  const paste = `[
  { "ClientSecret": "${TOK}", "UniqueId": "uid1", "Login": "buyer_acct", "Id": "1000000001", "integrityOk": true }
]

[
  { "ClientSecret": "${TOK2}", "UniqueId": "uid2", "Login": "spare_one", "Id": "1000000002", "integrityOk": true },
  { "ClientSecret": "t0kenkkkkklllllmmmmmnnnnnooooo", "Login": "spare_two", "Id": "1000000003" }
]`;
  const { entries, bad } = tr.parseReplacements(paste);
  assert.deepStrictEqual(bad, []);
  assert.deepStrictEqual(entries.map((e) => e.login), ["buyer_acct", "spare_one", "spare_two"]);
  assert.deepStrictEqual(entries[0], { login: "buyer_acct", token: TOK, uniqueId: "uid1", twitchId: "1000000001" });
});

test("login:token lines work, oauth: prefixes are stripped, bad input never echoes a token", () => {
  const { entries, bad } = tr.parseReplacements(`# comment\nabc123:oauth:${TOK}\nnot a line\nshort:zzz\n`);
  assert.deepStrictEqual(entries, [{ login: "abc123", token: TOK, uniqueId: "", twitchId: "" }]);
  assert.strictEqual(bad.length, 2);
  assert.ok(!JSON.stringify(bad).includes("zzz"), "bad entries report the login and why, never the token");
});

test("a token the fetcher marked integrity-failing is refused; the last copy of a login wins", () => {
  const { entries, bad } = tr.parseReplacements([
    { Login: "a1", ClientSecret: TOK, integrityOk: false },
    { Login: "b1", ClientSecret: TOK },
    { Login: "B1", ClientSecret: TOK2 },
  ]);
  assert.deepStrictEqual(bad.map((b) => b.login), ["a1"]);
  assert.deepStrictEqual(entries, [{ login: "B1", token: TOK2, uniqueId: "", twitchId: "" }]);
});

// ---- pure config helpers ---------------------------------------------------

test("applyToConfig changes only that login (any case) and reports real changes", () => {
  const cfg = { TwitchSettings: { TwitchUsers: [
    { Login: "Buyer_Acct", ClientSecret: "dead", UniqueId: "u0", Id: "1", Enabled: true },
    { Login: "other", ClientSecret: "keep", Enabled: true },
  ] } };
  const e = { token: TOK, uniqueId: "u1", twitchId: "1000000001" };
  assert.strictEqual(tr.applyToConfig(cfg, "buyer_acct", e), 1);
  assert.deepStrictEqual(cfg.TwitchSettings.TwitchUsers[0], { Login: "Buyer_Acct", ClientSecret: TOK, UniqueId: "u1", Id: "1000000001", Enabled: true });
  assert.strictEqual(cfg.TwitchSettings.TwitchUsers[1].ClientSecret, "keep");
  assert.strictEqual(tr.applyToConfig(cfg, "buyer_acct", e), 0, "same values again = nothing to write");
});

test("containerForFile follows the bot naming", () => {
  assert.strictEqual(tr.containerForFile("config.json"), "twitchbot");
  assert.strictEqual(tr.containerForFile("config_06.json"), "twitchbotx6");
  assert.strictEqual(tr.containerForFile("config_44.json"), "twitchbotx44");
  assert.strictEqual(tr.containerForFile("config_rent-3.json"), null);
});

// ---- orchestration ---------------------------------------------------------

function fakeModel(rows) {
  const match = (doc, q) =>
    Object.entries(q).every(([k, v]) => {
      const val = doc[k];
      if (v instanceof RegExp) return v.test(String(val == null ? "" : val));
      if (v && typeof v === "object" && "$not" in v) return !v.$not.test(String(val == null ? "" : val));
      if (v && typeof v === "object" && "$ne" in v) return val !== v.$ne;
      return val === v;
    });
  const model = {
    rows,
    writes: 0,
    findOne: (q) => ({ lean: async () => { const r = rows.find((d) => match(d, q)); return r ? { ...r } : null; } }),
    find: (q) => ({ lean: async () => rows.filter((d) => match(d, q)).map((r) => ({ ...r })) }),
    async updateOne(q, u) { const r = rows.find((d) => match(d, q)); if (r) { Object.assign(r, u.$set); model.writes++; } return { modifiedCount: r ? 1 : 0 }; },
    async updateMany(q, u) { const rs = rows.filter((d) => match(d, q)); rs.forEach((r) => Object.assign(r, u.$set)); model.writes += rs.length; return { modifiedCount: rs.length }; },
  };
  return model;
}

function world({ files = {}, running = {}, nc = {}, ncRunning = [], pool = [], bots = [], renters = [], supplied = [], inventory, campaigns }) {
  const calls = { writes: [], restarts: [], sh: [], enqueued: [], events: [] };
  const shq = (s) => "'" + s + "'";
  const homes = [
    ...Object.entries(files).map(([where, cfg]) => ({ where, cfg: JSON.parse(JSON.stringify(cfg)) })),
    ...Object.entries(nc).map(([id, cfg]) => ({ where: "no-claim bot " + id, cfg: JSON.parse(JSON.stringify(cfg)) })),
  ];
  const deps = {
    hosts: {
      shq,
      resolveHost: (id) => ({ id }),
      readFile: async (host, file) => JSON.stringify(files[host.id + "/" + file]),
      writeFileAtomic: async (host, file, text) => { files[host.id + "/" + file] = JSON.parse(text); calls.writes.push(host.id + "/" + file); },
      dockerPs: async (host) => Object.fromEntries((running[host.id] || []).map((c) => [c, { state: "running" }])),
      dockerContainer: async (host, action, c) => { calls.restarts.push(host.id + "/" + c + ":" + action); },
    },
    fleet: {
      configPath: (id) => "/nc/bots/" + id + "/Configuration/config.json",
      pi: () => ({ id: "contabo" }),
      containerFor: (id) => "noclaim-bot-" + id,
      async sh(script, opts = {}) {
        calls.sh.push(script);
        const r = /^cat '\/nc\/bots\/(\d+)\/Configuration\/config.json'$/.exec(script);
        if (r) return JSON.stringify(nc[r[1]]);
        const w = /^cat > '\/nc\/bots\/(\d+)\//.exec(script);
        if (w) { nc[w[1]] = JSON.parse(opts.input); calls.writes.push("no-claim bot " + w[1]); return ""; }
        if (/docker inspect/.test(script)) {
          const id = (script.match(/noclaim-bot-(\d+)/) || [])[1];
          if (ncRunning.includes(id)) { calls.restarts.push("noclaim-bot-" + id + ":restart"); return "restarted"; }
          return "";
        }
        return "";
      },
    },
    withFileLock: (host, file, fn) => fn(),
    fetchInventory: async (token) => inventory(token),
    fetchDropCampaigns: async (token) => campaigns(token),
    readAllHomes: async () => ({ homes, unreadable: [] }),
    enqueueCheck: (ids) => calls.enqueued.push(...ids),
    logEvent: (e) => calls.events.push(e),
    AvailableAccount: fakeModel(pool),
    BotAccount: fakeModel(bots),
    RenterAccount: fakeModel(renters),
    SuppliedAccount: fakeModel(supplied),
  };
  return { deps, calls, files, nc };
}

const cfgWith = (...users) => ({ TwitchSettings: { TwitchUsers: users } });
const okInventory = (login, id) => async () => ({ login, twitchId: id, drops: [] });
const okCampaigns = async () => new Array(160).fill({});

test("a paying renter's account: its bot config, renter row and pool row get the token; its running bot restarts", async () => {
  const w = world({
    files: { "contabo/config_06.json": cfgWith({ Login: "buyer_acct", ClientSecret: "dead", Enabled: true }, { Login: "buyer2", ClientSecret: "fine", Enabled: true }) },
    running: { contabo: ["twitchbotx6"] },
    pool: [{ _id: "p1", usernameLower: "buyer_acct", username: "buyer_acct", clientSecret: "dead", lastCheckStatus: "token_invalid" }],
    renters: [{ _id: "r1", login: "buyer_acct", clientSecret: "dead", enabled: true, lastScanStatus: "token_invalid" }],
    inventory: async () => ({ login: "buyer_acct", twitchId: "1000000001" }),
    campaigns: okCampaigns,
  });
  const out = await tr.replaceTokens([{ Login: "buyer_acct", ClientSecret: TOK, UniqueId: "uid1", Id: "1000000001" }], { actor: "admin:x" }, w.deps);
  const r = out.results[0];
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual(r.updated, ["contabo/config_06.json", "pool row", "renter row"]);
  assert.deepStrictEqual(r.restarted, ["contabo/twitchbotx6"]);
  const users = w.files["contabo/config_06.json"].TwitchSettings.TwitchUsers;
  assert.deepStrictEqual(users[0], { Login: "buyer_acct", ClientSecret: TOK, Enabled: true, UniqueId: "uid1", Id: "1000000001" });
  assert.strictEqual(users[1].ClientSecret, "fine", "the other buyer in that bot is untouched");
  assert.strictEqual(w.deps.RenterAccount.rows[0].clientSecret, TOK);
  assert.strictEqual(w.deps.RenterAccount.rows[0].lastScanStatus, "pending");
  assert.strictEqual(w.deps.AvailableAccount.rows[0].clientSecret, TOK);
  assert.strictEqual(w.deps.AvailableAccount.rows[0].lastCheckStatus, "", "left for the normal pool check");
  assert.deepStrictEqual(w.calls.enqueued, ["p1"]);
  assert.strictEqual(w.calls.events.length, 1);
  assert.ok(!JSON.stringify(out).includes(TOK) && !JSON.stringify(w.calls.events).includes(TOK), "the token is never returned or logged");
});

test("a pool-only account: just its pool row, nothing restarted", async () => {
  const w = world({
    pool: [{ _id: "p2", usernameLower: "spare_three", username: "spare_three", clientSecret: "dead", lastCheckStatus: "integrity_failed" }],
    inventory: okInventory("spare_three", "1000000004"),
    campaigns: okCampaigns,
  });
  const out = await tr.replaceTokens(`spare_three:${TOK}`, {}, w.deps);
  assert.strictEqual(out.results[0].ok, true);
  assert.deepStrictEqual(out.results[0].updated, ["pool row"]);
  assert.deepStrictEqual(w.calls.restarts, []);
  assert.strictEqual(w.deps.AvailableAccount.rows[0].twitchId, "1000000004");
});

async function refused(opts, token, expectReason) {
  const base = {
    files: { "contabo/config_06.json": cfgWith({ Login: "acc", ClientSecret: "dead", Enabled: true }) },
    running: { contabo: ["twitchbotx6"] },
    pool: [{ _id: "p", usernameLower: "acc", username: "acc", clientSecret: "dead" }],
    renters: [{ _id: "r", login: "acc", clientSecret: "dead", enabled: true }],
    inventory: okInventory("acc", "1"),
    campaigns: okCampaigns,
    ...opts,
  };
  const w = world(base);
  const out = await tr.replaceTokens([{ Login: "acc", ClientSecret: token }], {}, w.deps);
  const r = out.results[0];
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, expectReason);
  assert.deepStrictEqual(w.calls.writes, [], "no config written");
  assert.deepStrictEqual(w.calls.restarts, [], "nothing restarted");
  assert.strictEqual(w.deps.AvailableAccount.writes + w.deps.RenterAccount.writes + w.deps.BotAccount.writes, 0, "no row written");
}

test("refused, nothing written: the token belongs to a different account", () =>
  refused({ inventory: okInventory("someoneelse", "9") }, TOK, /belongs to someoneelse/));

test("refused, nothing written: Twitch rejects the token", () =>
  refused({ inventory: async () => { const e = new Error("x"); e.code = "token_invalid"; throw e; } }, TOK, /rejects this token/));

test("refused, nothing written: the token fails the integrity check", () =>
  refused({ campaigns: async () => { const e = new Error("failed integrity check"); e.code = "integrity_failed"; throw e; } }, TOK, /integrity/));

test("refused, nothing written: a restricted token that sees no campaigns", () =>
  refused({ campaigns: async () => [] }, TOK, /restricted/));

test("refused, nothing written: the token is already stored on another account", () =>
  refused({ bots: [{ _id: "b9", login: "victim", clientSecret: TOK, enabled: true }] }, TOK, /already stored on victim/));

test("refused, nothing written: the account is enabled in two bots at once", () =>
  refused({
    files: {
      "contabo/config_13.json": cfgWith({ Login: "acc", ClientSecret: "dead", Enabled: true }),
      "contabo/config_14.json": cfgWith({ Login: "ACC", ClientSecret: "dead", Enabled: true }),
    },
  }, TOK, /enabled in 2 bots/));

test("a no-claim bot's config is rewritten in place; a stopped no-claim bot is not started", async () => {
  const w = world({
    nc: { "25": cfgWith({ Login: "ncacc", Id: "5", ClientSecret: "dead", Enabled: true, FavouriteGames: ["Overwatch"] }) },
    ncRunning: [],
    pool: [{ _id: "p5", usernameLower: "ncacc", username: "ncacc", clientSecret: "dead" }],
    inventory: okInventory("ncacc", "5"),
    campaigns: okCampaigns,
  });
  const out = await tr.replaceTokens([{ Login: "ncacc", ClientSecret: TOK }], {}, w.deps);
  assert.strictEqual(out.results[0].ok, true, out.results[0].reason);
  assert.deepStrictEqual(out.results[0].updated, ["no-claim bot 25", "pool row"]);
  assert.deepStrictEqual(out.results[0].restarted, []);
  assert.strictEqual(w.nc["25"].TwitchSettings.TwitchUsers[0].ClientSecret, TOK);
  assert.deepStrictEqual(w.nc["25"].TwitchSettings.TwitchUsers[0].FavouriteGames, ["Overwatch"]);
  assert.ok(w.calls.sh.some((s) => /cat > '\/nc\/bots\/25\/Configuration\/config.json.tmp' && mv .* && chmod 600/.test(s)), "atomic write, chmod 600");
});

test("more than 25 accounts in one paste is refused before any Twitch call", async () => {
  const w = world({ inventory: async () => { throw new Error("must not be called"); }, campaigns: okCampaigns });
  const many = Array.from({ length: 26 }, (_, i) => ({ Login: "acct" + i, ClientSecret: TOK }));
  await assert.rejects(tr.replaceTokens(many, {}, w.deps), (e) => e.status === 413);
});
