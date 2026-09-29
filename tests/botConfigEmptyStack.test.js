// A new rental stack must not inherit the template bot's farming games.
//
// provisionEmptyConfig clones `config.json`, and on contabo that is a WORKING
// operator bot whose root FavouriteGames were Warframe / Summer Game Fest /
// Assassin's Creed Black Flag (2026-09-30). config_56/57 came out carrying
// them. Rent-farm accounts are pinned per account to the game the buyer paid
// for, and every live rental stack (config_06, config_54) has an empty root
// list — so a stack that inherits the operator's list can pull a buyer's
// account onto games nobody bought. The two new stacks were fixed by hand;
// these tests keep the next one from needing it.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// contabo config.json, 2026-09-30, reduced to the keys that matter (users are
// placeholders — no real accounts in a test).
function contaboTemplate() {
  return {
    AttemptToWatch: 3,
    FavouriteGames: ["Warframe", "Summer Game Fest", "Assassin's Creed Black Flag Resynced"],
    KickSettings: { KickUsers: [{ Login: "kick-placeholder" }] },
    LaunchOnStartup: false,
    LogLevel: 0,
    MinimizeInTray: false,
    TwitchSettings: {
      AvoidCampaign: [],
      ClaimDrops: true,
      ForceTryWithTags: false,
      MinimizeInTray: false,
      OnlyConnectedAccounts: false,
      OnlyFavouriteGames: true,
      TwitchUsers: [
        { Login: "operator-1", ClientSecret: "x1", FavouriteGames: ["Warframe"] },
        { Login: "operator-2", ClientSecret: "x2", FavouriteGames: ["Summer Game Fest"] },
      ],
      WatchManager: "WatchBrowser",
    },
    WaitingSeconds: 60,
    WatchBrowserHeadless: true,
    WebhookURL: "",
  };
}

function loadRoutes(stubs) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /botConfigRoutes\.js$/.test(parent.filename || "");
    if (from && stubs[request]) return stubs[request];
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const p = require.resolve("../routes/botConfigRoutes");
    delete require.cache[p];
    const mod = require("../routes/botConfigRoutes");
    delete require.cache[p];
    return { mod, restore: () => { Module._load = realLoad; } };
  } catch (e) {
    Module._load = realLoad;
    throw e;
  }
}

test("emptyStackConfig drops the users AND the template's farming games", () => {
  const { mod, restore } = loadRoutes({});
  try {
    const out = mod.emptyStackConfig(contaboTemplate());
    assert.deepStrictEqual(out.TwitchSettings.TwitchUsers, []);
    assert.deepStrictEqual(out.KickSettings.KickUsers, []);
    assert.deepStrictEqual(out.FavouriteGames, [], "a rental stack starts with no root games");
  } finally { restore(); }
});

test("every other template setting is kept exactly", () => {
  // Only what belongs to the template BOT goes. OnlyFavouriteGames stays true —
  // the live rental stacks run with true + an empty root list + per-account
  // games — and MinimizeInTray is a desktop setting a native host may rely on.
  const { mod, restore } = loadRoutes({});
  try {
    const tpl = contaboTemplate();
    const out = mod.emptyStackConfig(contaboTemplate());
    const strip = (d) => {
      const c = JSON.parse(JSON.stringify(d));
      delete c.FavouriteGames;
      delete c.TwitchSettings.TwitchUsers;
      delete c.KickSettings.KickUsers;
      return c;
    };
    assert.deepStrictEqual(strip(out), strip(tpl));
    assert.strictEqual(out.TwitchSettings.OnlyFavouriteGames, true);
    assert.strictEqual(out.MinimizeInTray, false);
  } finally { restore(); }
});

test("a template with no TwitchSettings still yields a valid empty stack", () => {
  const { mod, restore } = loadRoutes({});
  try {
    const out = mod.emptyStackConfig({ FavouriteGames: ["Rust"] });
    assert.deepStrictEqual(out.TwitchSettings, { TwitchUsers: [] });
    assert.deepStrictEqual(out.FavouriteGames, []);
    assert.deepStrictEqual(mod.emptyStackConfig(null).TwitchSettings, { TwitchUsers: [] });
  } finally { restore(); }
});

test("REGRESSION 2026-09-30: provisionEmptyConfig on the contabo layout writes a clean stack", async () => {
  const files = ["config.json", "config_06.json", "config_54.json", "config_55.json", "docker-compose.yml"];
  const writes = {};
  const composeWrites = [];
  const registered = [];
  const compose =
    "services:\n" +
    "  twitchbotx55:\n" +
    "    image: twitchbot-farm:latest\n" +
    "    container_name: twitchbotx55\n" +
    "    volumes:\n" +
    "      - ./config_55.json:/app/Configuration/config.json\n";
  const hostsStub = {
    readdir: async () => files.slice(),
    composeName: async () => "docker-compose.yml",
    exists: async (_h, f) => files.includes(f) || !!writes[f],
    readFile: async (_h, f) => {
      assert.strictEqual(f, "config.json", "the template is config.json, as on contabo");
      return JSON.stringify(contaboTemplate());
    },
    writeFileAtomic: async (_h, f, text) => { writes[f] = text; },
    composeRead: async () => compose,
    composeWrite: async (_h, _name, text) => { composeWrites.push(text); },
    rename: async () => {},
  };
  const stacksStub = {
    registerStack: async (host, file) => { registered.push(host + "/" + file); },
    requireStack: async () => ({}),
    dedicatedConfigSet: async () => new Set(),
    assertCapacity: () => ({}),
  };
  const { mod, restore } = loadRoutes({
    "../utils/botHosts": hostsStub,
    "../utils/renterBotStacks": stacksStub,
  });
  try {
    const slot = await mod.provisionEmptyConfig({ id: "contabo", dir: "/home/ubuntu/twitchbot" });
    assert.deepStrictEqual(slot, { host: "contabo", file: "config_56.json", container: "twitchbotx56" });
    const written = JSON.parse(writes["config_56.json"]);
    assert.deepStrictEqual(written.FavouriteGames, [], "no inherited operator games");
    assert.deepStrictEqual(written.TwitchSettings.TwitchUsers, []);
    assert.strictEqual(written.TwitchSettings.OnlyFavouriteGames, true);
    assert.strictEqual(composeWrites.length, 1);
    assert.match(composeWrites[0], /twitchbotx56/);
    assert.match(composeWrites[0], /\.\/config_56\.json:\/app\/Configuration\/config\.json/);
    assert.deepStrictEqual(registered, ["contabo/config_56.json"]);
  } finally { restore(); }
});
