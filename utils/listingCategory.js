// "Where does this listing go on this marketplace?" — answered once, for every
// marketplace, in one shape.
//
// WHY THIS EXISTS
// We only sell one product: Twitch drop accounts. Yet three markets still made
// the owner type a placement by hand on every publish (Plati/Digiseller's
// cataloguer category + attributes, GGSel's per-game category, FunPay's bare
// numeric node), while utils/autoLister.js has been publishing to seven markets
// with no human at all. This module is the auto-lister's knowledge lifted out
// so the manual modal can use it too — see docs/ACCOUNT-LISTINGS-CONTRACT.md.
//
// THREE RULES THIS FILE IS BUILT AROUND
//
// 1. EACH "NO ANSWER" STAYS DIFFERENT. A miss on GGSel means "fall back to the
//    configured default"; a miss on G2G means "this game is NOT LISTABLE there
//    and never will be" (utils/g2gGames.js NOT_LISTABLE — Overwatch, Siege);
//    a miss on FunPay means "nobody has mapped this game's node yet". An
//    "always pick something" rule is exactly how a Twitch-drop bundle ends up
//    filed under the wrong game's forum, which is the failure brandForGame
//    returning null exists to prevent. So resolution NEVER guesses: it returns
//    ok:false with a reason the UI can show, and the owner picks by hand.
//
// 2. EVERY CALL IS BOUNDED. mp.ggselCategoryHistory (utils/marketplaces.js:2048)
//    is a SERIAL loop of awaited axios calls at a 20s timeout each, over up to
//    100 offers. On a cold cache that is minutes of a superadmin's HTTP request
//    held open, and this runs on every modal open. Every resolver call races a
//    timer, and losing the race is treated as a miss (falling back to the
//    settings value where one exists) rather than as an error.
//
// 3. NOTHING IS REQUIRED UNTIL IT IS USED. Same dependency seam as
//    utils/systemHealth.js:52-94: factories, never values. A test injects deps
//    and the real marketplaces module — which owns every live API key — is
//    never even loaded. No network call happens at require time.

// Per-resolver wall clock. Overridable per call via `opts.timeoutMs`; mutating
// the export does nothing, because each call reads its own budget.
const RESOLVE_TIMEOUT_MS = 8000;

// Two TTLs, on purpose. A hit is stable (GGSel's category tree changes when
// GGSel adds a game, not hourly). A MISS is cached too, and that is the half
// that matters: without it a game name GGSel has never heard of re-triggers the
// serial history loop on every single modal open. The miss TTL is short so a
// newly-configured setting is not invisible for half an hour.
//
// A DEGRADED hit takes the miss TTL as well (F5): an answer that exists only
// because the live lookup timed out is a transient fault wearing a hit's
// clothes, and remembering it for thirty minutes publishes half an hour of
// real offers into the generic default category.
const CACHE_TTL_MS = 30 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
// A DEGRADED answer gets seconds, not minutes. Its live lookup was abandoned
// but is STILL RUNNING and warms the marketplace module's own cache behind us,
// so the correct answer is usually moments away — measured on prod 2026-09-10:
// GGSel cold 54s (always over the 8s bound), then 711ms with the real category.
// Long enough to stop a re-opened modal re-entering that serial crawl, short
// enough that the owner is never told "no category" for a game that has one.
const DEGRADED_TTL_MS = 15 * 1000;

// The markets whose publish body carries a placement the owner used to type.
// These are the four boxes on the Listings modal and the four branches that get
// a server-side fallback in POST /marketplaces/publish. The rest resolve with
// no UI already and are here only so one call can answer for all of them.
const MARKETS_NEEDING_CATEGORY = ["ggsel", "digiseller", "funpay", "g2g"];

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

const REAL_DEPS = {
  marketplaces: () => require("./marketplaces"),
  g2gGames: () => require("./g2gGames"),
  epicnpc: () => require("./epicnpcCatalog"),
  settings: () => require("./settings"),
  // Feature A's canonical game resolver. Only touched when the caller hands us
  // a listing/set/offer instead of a plain string, so this module still loads
  // (and every string-game resolver still works) if it is absent.
  listingGame: () => require("./listingGame"),
};

function makeCtx(deps = {}) {
  const cache = new Map();
  return {
    dep(name) {
      if (Object.prototype.hasOwnProperty.call(deps, name)) return deps[name];
      if (!cache.has(name)) {
        const make = REAL_DEPS[name];
        if (!make) {
          throw new Error("listingCategory: unknown dependency " + name);
        }
        cache.set(name, make());
      }
      return cache.get(name);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Punctuation and case drift between DropLog.game, the settings maps and each
// marketplace's own label is constant ("Tom Clancy's Rainbow Six Siege" vs
// "rainbow six siege"), so every comparison goes through this.
function normGame(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/tom clancy'?s/g, "")
    .replace(/[’'`:.,\-–™®_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Loose match, for marketplace-supplied labels only ("Albion Online (Global)
// Items" carries the game plus their own decoration). Never used for a settings
// map: a wrong node there is a listing in another game's section, so those stay
// exact. The length floor stops a short token like "ufl" matching inside an
// unrelated title.
function labelCarriesGame(label, game) {
  const a = normGame(label);
  const b = normGame(game);
  if (!a || b.length < 3) return false;
  return a === b || a.includes(b);
}

// `degraded` means "this answer is only as good as the fallback behind it":
// the live lookup did not say no, it FAILED (timed out, threw), and we filled
// the gap from settings. It is still ok:true — the publish must not be blocked
// by GGSel being slow — but the cache must treat it as a miss (F5 below).
function ok(marketplace, { value, label, source, degraded }) {
  return {
    ok: true,
    marketplace,
    value: value || {},
    label: String(label || ""),
    source: source || "static",
    reason: "",
    degraded: Boolean(degraded),
  };
}

function miss(marketplace, reason, source, degraded) {
  return {
    ok: false,
    marketplace,
    value: {},
    label: "",
    source: source || "none",
    reason: String(reason || ""),
    // A miss whose cause was a timeout, not an answer. Measured on prod
    // 2026-09-10: GGSel's first resolve after a restart takes 54s (its history
    // crawl is a serial loop of awaited calls), so the 8s bound ALWAYS fires
    // cold — and the underlying lookup keeps running and warms the cache, so
    // the very next call answers in 711ms. Caching that first miss for the
    // full 5 minutes therefore hides a correct answer we already have, and the
    // owner is told to pick a category by hand for five minutes after every
    // deploy — which is the entire thing this feature exists to remove.
    degraded: Boolean(degraded),
  };
}

// Losing the race does not cancel the underlying request — nothing here
// mutates, so an abandoned read is harmless. The timer is cleared on every
// path, so it can only hold the event loop open while a lookup is in flight.
function withTimeout(promise, ms, label) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            label +
              " timed out after " +
              (ms >= 1000 ? Math.round(ms / 1000) + "s" : ms + "ms"),
          ),
        ),
      ms,
    );
  });
  return Promise.race([Promise.resolve().then(() => promise), expiry]).finally(
    () => {
      if (timer) clearTimeout(timer);
    },
  );
}

// Every resolver funnels its I/O through here, so "bounded" is not something a
// future resolver can forget. A rejection (including the timeout) becomes
// `null`, which each resolver reads as its own flavour of miss.
//
// F5: "the market said no" and "we never got an answer" arrive here as the
// SAME null, and for a resolver with a settings fallback the difference is the
// whole story — one is a stable fact, the other is a transient fault we are
// about to remember for half an hour. Pass a `state` object to have the
// failure recorded on it; the resolver that owns the fallback marks its own
// resolution `degraded`, because only it knows whether the fallback was taken.
async function tryCall(fn, ms, label, state) {
  try {
    const out = await withTimeout(fn(), ms, label);
    return out === undefined ? null : out;
  } catch (e) {
    if (state) state.failed = (e && e.message) || String(e) || "failed";
    return null;
  }
}

function autoFarm(ctx) {
  try {
    return ctx.dep("settings").getAutoFarm() || {};
  } catch {
    // settings.json unreadable is not this module's problem to raise — every
    // settings-backed resolver below degrades to its own miss reason.
    return {};
  }
}

// ---------------------------------------------------------------------------
// Resolvers — one per marketplace, one shape out
// ---------------------------------------------------------------------------

const RESOLVERS = {
  // GGSel has a per-game "Twitch Drops" section, often at a 2% fee instead of
  // 15%+, so the live lookup is worth its cost. It is also the expensive one
  // (see rule 2 at the top).
  async ggsel(ctx, game, ms) {
    const mp = ctx.dep("marketplaces");
    // See F5 in docs/ACCOUNT-LISTINGS-FIXES.md. `live.failed` separates "GGSel
    // has no Twitch Drops shelf for this game" from "GGSel did not answer in
    // 8s" — both leave categoryId empty and both fall back, but only the
    // second one must expire quickly.
    const live = { failed: "" };
    let categoryId = "";
    if (game) {
      categoryId = String(
        (await tryCall(
          () => mp.ggselResolveCategoryId(game),
          ms,
          "GGSel category lookup",
          live,
        )) || "",
      );
    }
    if (categoryId) {
      return ok("ggsel", {
        value: { categoryId },
        label: "GGSel category " + categoryId,
        // ggselResolveCategoryId collapses its own history/search/accounts
        // ladder into a bare id string (marketplaces.js:2111-2166), so which
        // rung answered is not observable from here.
        source: "search",
      });
    }
    const fallback = String(autoFarm(ctx).ggselCategoryId || "").trim();
    if (fallback) {
      return ok("ggsel", {
        value: { categoryId: fallback },
        // The suffix is not decoration: the per-game Twitch Drops section is
        // often 2% where the generic default is 15%+, so an owner staring at
        // the auto line needs to know the shelf was chosen because GGSel was
        // unreachable, not because this game has none.
        label:
          "GGSel default category " +
          fallback +
          (live.failed ? " (live lookup unavailable)" : ""),
        source: "settings",
        // F5: cached under the MISS TTL instead of 30 minutes, or one timeout
        // publishes half an hour of real offers into the generic category.
        degraded: Boolean(live.failed),
      });
    }
    if (!game) {
      return miss(
        "ggsel",
        "No game on this listing, so GGSel's category cannot be resolved",
      );
    }
    // Say which of the two it is. Reporting "GGSel has no category for X" when
    // the lookup merely timed out is a lie the owner acts on — they go and pick
    // a category by hand for a game that resolves perfectly well a second
    // later. Measured on prod: 121685 for Rocket League, 121199 for Overwatch 2.
    if (live.failed) {
      return miss(
        "ggsel",
        "GGSel did not answer in time (" +
          live.failed +
          ") — reopen this in a few seconds, the lookup is still running and " +
          "warms up. Set a default in Auto-farm settings to skip the wait.",
        "none",
        true,
      );
    }
    return miss(
      "ggsel",
      'GGSel has no Twitch Drops category for "' +
        game +
        '" and no default is set in Auto-farm settings',
    );
  },

  // Plati/Digiseller's placement is fixed for our whole product line: cataloguer
  // category 34187 plus the Content-type attribute, without which the create
  // fails "you can not add goods". It is a settings value, not a lookup.
  async digiseller(ctx) {
    const af = autoFarm(ctx);
    const categoryId = String(af.platiCategoryId || "").trim();
    if (!categoryId) {
      return miss(
        "digiseller",
        "No Plati category configured in Auto-farm settings",
      );
    }
    const attributes = Array.isArray(af.platiAttributes)
      ? af.platiAttributes
      : [];
    return ok("digiseller", {
      value: { categories: [{ owner: 1, categoryId, attributes }] },
      label:
        "Plati cataloguer category " +
        categoryId +
        (attributes.length ? " + " + attributes.length + " attribute(s)" : ""),
      source: "settings",
    });
  },

  // FunPay is a bare numeric node typed from memory, and a wrong one lists the
  // account in a different game's section where nobody looking for this game
  // will ever see it. So the match is EXACT on the normalised name — no fuzzy
  // fallback, the same rule epicnpcCatalog.nodeForGame enforces and for the
  // same reason.
  async funpay(ctx, game) {
    if (!game) {
      return miss(
        "funpay",
        "No game on this listing, so no FunPay node can be matched",
      );
    }
    const map = autoFarm(ctx).funpayNodes || {};
    const want = normGame(game);
    let node = "";
    for (const key of Object.keys(map)) {
      if (normGame(key) === want) {
        node = String(map[key] || "").trim();
        break;
      }
    }
    if (!node) return miss("funpay", "No FunPay node mapped for " + game);
    // `node` is the contract's name; `nodeId` is what the publish route reads
    // (routes/marketplaceRoutes.js:842 `if (!fp.nodeId)`). Both are written so
    // merging this straight into the publish body works either way.
    return ok("funpay", {
      value: { node, nodeId: node },
      label: "FunPay node " + node,
      source: "settings",
    });
  },

  // On G2G the brand IS the game, and a null brand is a DELIBERATE refusal:
  // those games have no creatable Game Items product at all (probed live
  // 2026-09-08), so there is nothing to fall back to and nothing to guess.
  async g2g(ctx, game) {
    if (!game) {
      return miss(
        "g2g",
        "No game on this listing, so no G2G brand can be resolved",
      );
    }
    const g2gGames = ctx.dep("g2gGames");
    const brand = g2gGames.brandForGame(game);
    if (!brand) {
      return miss("g2g", "G2G does not list " + game);
    }
    return ok("g2g", {
      value: {
        serviceId: g2gGames.G2G_ITEMS_SERVICE,
        brandId: brand.brandId,
        seoTerm: brand.seoTerm,
      },
      label: brand.marketingTitle || brand.seoTerm || brand.brandId,
      source: "catalog",
    });
  },

  // ZeusX: the operator's own zeusxGames map wins over the live menu, exactly
  // as zeusxPublish itself orders them (marketplaces.js:4425-4430) — a pinned
  // category is the operator saying "this one, I mean it", and it also skips
  // the network entirely.
  //
  // F5 does NOT apply here and the ordering is why: the settings value is read
  // BEFORE the lookup, so it can never be papering over a timeout, and a lost
  // race falls through to miss() — which already takes the short TTL. Keep it
  // that way; moving the pin below the lookup would recreate GGSel's bug.
  async zeusx(ctx, game, ms) {
    if (!game) {
      return miss(
        "zeusx",
        "No game on this listing, so no ZeusX category can be resolved",
      );
    }
    const pinned = zeusxPinned(autoFarm(ctx).zeusxGames || {}, game);
    if (pinned && pinned.serviceCategoryBaseId) {
      return ok("zeusx", {
        value: {
          serviceCategoryId: String(pinned.serviceCategoryId || "1"),
          serviceCategoryBaseId: String(pinned.serviceCategoryBaseId),
          gameId: String(pinned.gameId || ""),
        },
        label: "ZeusX base " + pinned.serviceCategoryBaseId + " (pinned)",
        source: "settings",
      });
    }
    const mp = ctx.dep("marketplaces");
    const hit = await tryCall(
      () => mp.zeusxResolveCategory(game),
      ms,
      "ZeusX category lookup",
    );
    if (!hit || !hit.serviceCategoryBaseId) {
      return miss(
        "zeusx",
        'ZeusX has no game called "' +
          game +
          '" in its Accounts catalog — map it by hand under ' +
          "autoFarm.zeusxGames",
      );
    }
    return ok("zeusx", {
      value: {
        serviceCategoryId: String(hit.serviceCategoryId || "1"),
        serviceCategoryBaseId: String(hit.serviceCategoryBaseId),
        gameId: String(hit.gameId || ""),
      },
      label: "ZeusX " + (hit.name || game),
      source: "search",
    });
  },

  // Eldorado has a NATIVE Twitch Drops category (gameId 235 / CustomItem) and
  // marketplaces.js pins it inside eldoradoPublish. There is nothing per-game
  // to resolve and therefore nothing that can miss.
  async eldorado() {
    return ok("eldorado", {
      value: {},
      label: "Eldorado > Twitch Drops",
      source: "static",
    });
  },

  // Gameflip picks its category from the delivery mode, not the game
  // (marketplaces.js:313 — an auto-delivered code MUST be UNKNOWN, because
  // DIGITAL_INGAME there means a Steam bot trade). So this too cannot miss, and
  // deliberately emits no value: overriding gameflipPublish's own choice from
  // here would break auto-delivery.
  async gameflip() {
    return ok("gameflip", {
      value: {},
      label: "Gameflip digital goods",
      source: "static",
    });
  },

  // PlayerAuctions needs BOTH halves — the game row and an item leaf — and only
  // 149 of their ~400 games accept an Item offer at all. Either half coming
  // back null is a deliberate refusal: publishing anyway earns "Invalid Item
  // Name" or a misfiled listing.
  async playerauctions(ctx, game, ms) {
    if (!game) {
      return miss(
        "playerauctions",
        "No game on this listing, so PlayerAuctions cannot be resolved",
      );
    }
    const mp = ctx.dep("marketplaces");
    const row = await tryCall(
      () => mp.playerauctionsResolveGame(game),
      ms,
      "PlayerAuctions game lookup",
    );
    if (!row || !row.gameId) {
      return miss("playerauctions", "PlayerAuctions has no game matching " + game);
    }
    // paGameSupports is not exported from marketplaces.js, so the same test is
    // inlined here (marketplaces.js:5925-5932). Keep the two in step.
    const types = String(row.productType || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim());
    if (!types.includes("item")) {
      return miss(
        "playerauctions",
        "PlayerAuctions game " +
          (row.gameName || game) +
          " does not accept Item offers (allowed: " +
          (row.productType || "none") +
          ")",
      );
    }
    const leaf = await tryCall(
      () => mp.playerauctionsPickItemPath(row.gameId),
      ms,
      "PlayerAuctions item category lookup",
    );
    if (!leaf || !leaf.itemPath) {
      return miss(
        "playerauctions",
        "No item category found for PlayerAuctions game " +
          (row.gameName || game),
      );
    }
    return ok("playerauctions", {
      value: {
        gameId: row.gameId,
        itemId: leaf.itemId,
        itemPath: leaf.itemPath,
        rootItem: leaf.rootItem,
      },
      label:
        (row.gameName || game) +
        " > " +
        (leaf.rootName || "") +
        (leaf.itemName && leaf.itemName !== leaf.rootName
          ? " > " + leaf.itemName
          : ""),
      source: "catalog",
    });
  },

  // EpicNPC is a forum: the node decides which game's board the thread lands
  // on. nodeForGame is exact-match by design and returns null rather than the
  // nearest board.
  async epicnpc(ctx, game) {
    if (!game) {
      return miss(
        "epicnpc",
        "No game on this listing, so no EpicNPC node can be resolved",
      );
    }
    const hit = ctx.dep("epicnpc").nodeForGame(game);
    if (!hit) return miss("epicnpc", "EpicNPC has no forum for " + game);
    return ok("epicnpc", {
      value: { node: hit.node },
      label: "EpicNPC > " + (hit.name || game),
      source: "static",
    });
  },

  // Z2U's "category" is the (service, game) pair its own seller panel uses, and
  // BOTH are numeric group ids — z2uGameOptions(service, game) feeds them
  // straight into /downloadTemp (marketplaces.js:7317-7331). So a game NAME has
  // to be turned into that pair first, off the seller's own group list; a
  // caller that already knows the pair passes it in opts.z2u and skips the
  // extra round trip.
  async z2u(ctx, game, ms, opts) {
    const mp = ctx.dep("marketplaces");
    const pin = opts.z2u || {};
    let service = String(pin.service || "");
    let gameId = String(pin.game || "");
    if (!service || !gameId) {
      if (!game) {
        return miss(
          "z2u",
          "No game on this listing, so no Z2U group can be resolved",
        );
      }
      const groups =
        (await tryCall(() => mp.z2uGroups(), ms, "Z2U group list")) || [];
      const hit = groups.find((g) => g && labelCarriesGame(g.label, game));
      if (!hit) {
        return miss("z2u", "Z2U has no seller group for " + game);
      }
      service = String(hit.service);
      gameId = String(hit.game);
    }
    const info = await tryCall(
      () => mp.z2uGameOptions(service, gameId),
      ms,
      "Z2U template lookup",
    );
    if (!info || !info.gameName) {
      return miss(
        "z2u",
        "Z2U did not return a template for " + (game || gameId),
      );
    }
    return ok("z2u", {
      // `game` rides along because service+gameName alone cannot address the
      // group again — the ids are what every other Z2U call takes.
      value: {
        gameName: info.gameName,
        service: info.service || service,
        game: gameId,
      },
      label: "Z2U " + info.gameName,
      source: "catalog",
    });
  },
};

// zeusxGameConfig's matching rule (marketplaces.js), reimplemented over the
// injected settings so it is testable without loading marketplaces at all.
function zeusxPinned(map, game) {
  const key = String(game || "").trim().toLowerCase();
  if (!key) return null;
  if (map[key]) return map[key];
  const hit = Object.keys(map).find(
    (k) => k && (key.includes(k.toLowerCase()) || k.toLowerCase().includes(key)),
  );
  return hit ? map[hit] : null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// Only the resolvers that leave the process are cached. Caching a settings read
// would be worse than useless: the owner fixes a missing FunPay node, reopens
// the modal, and for thirty minutes still sees "No FunPay node mapped" — with
// no cost saved, because the read was a local file to begin with.
const NETWORK_MARKETS = new Set(["ggsel", "zeusx", "playerauctions", "z2u"]);

const cache = new Map(); // key -> { until, resolution }
// In-flight de-duplication. Two modal opens a second apart must not both enter
// the GGSel serial loop; the second one waits on the first.
const inflight = new Map(); // key -> Promise<Resolution>

function cacheKey(marketplace, game) {
  return marketplace + "|" + String(game || "").toLowerCase();
}

function clearCache() {
  cache.clear();
  inflight.clear();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// resolveCategory(marketplace, game, opts?) -> Promise<Resolution>
//
// `game` is normally a plain string. A listing/set/offer object is accepted and
// funnelled through utils/listingGame, so a caller that has the row but not the
// name does not have to spell the precedence chain out again.
//
// opts = { deps, timeoutMs, noCache, z2u }
//
// NEVER throws and never rejects: a miss is a Resolution with ok:false, because
// the only caller is an HTTP route that must not 500 on an unmapped game.
async function resolveCategory(marketplace, game, opts = {}) {
  const market = String(marketplace || "")
    .trim()
    .toLowerCase();
  const resolver = RESOLVERS[market];
  if (!resolver) {
    return miss(market, "No category resolver for " + (marketplace || "?"));
  }

  const ctx = makeCtx(opts.deps || {});
  const name = gameName(ctx, game);
  const ms =
    Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RESOLVE_TIMEOUT_MS;
  const key = cacheKey(market, name);
  const cacheable = NETWORK_MARKETS.has(market) && !opts.noCache;

  if (cacheable) {
    const hit = cache.get(key);
    if (hit && Date.now() < hit.until) return hit.resolution;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const run = (async () => {
    let out;
    try {
      out = await resolver(ctx, name, ms, opts);
    } catch (e) {
      // A resolver that throws is a miss, not a 500. It also gets the SHORT
      // TTL below, so a transient marketplace fault heals in five minutes.
      out = miss(market, (e && e.message) || String(e));
    }
    const resolution = out && typeof out === "object" ? out : miss(market, "");
    if (cacheable) {
      // F5: `degraded` is set by the resolver that took a settings fallback
      // after its live lookup FAILED, and such an answer is a miss as far as
      // this cache is concerned — thirty minutes of it is thirty minutes of
      // real offers published into the generic default category. The flag is
      // never inferred here: from the cache's seat a timed-out GGSel and a
      // game GGSel genuinely has no shelf for look identical.
      //
      // Three tiers, not two. A DEGRADED answer — ok or miss — is one whose
      // live lookup never came back, and the lookup it abandoned is still
      // running and about to populate the marketplace module's own cache.
      // Measured on prod 2026-09-10: GGSel cold = 54s (over the 8s bound, so
      // always a degraded miss), and the very next call = 711ms with the right
      // answer. Holding the degraded answer for even five minutes throws away
      // a correct one we already have, so it gets seconds — just enough to stop
      // a modal re-open stampede re-entering that serial crawl.
      const stable = resolution.ok && !resolution.degraded;
      const ttl = stable
        ? CACHE_TTL_MS
        : resolution.degraded
          ? DEGRADED_TTL_MS
          : MISS_TTL_MS;
      cache.set(key, { until: Date.now() + ttl, resolution });
    }
    return resolution;
  })();

  if (!cacheable) return run;
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

function gameName(ctx, game) {
  if (typeof game === "string") return game.trim();
  if (!game || typeof game !== "object") return "";
  try {
    return String(ctx.dep("listingGame").listingGame(game) || "").trim();
  } catch {
    // utils/listingGame is Feature A's other half; if it is not present yet,
    // an object argument degrades to the two spellings we can read here rather
    // than taking the whole resolver down.
    return String(game.game || game.coverGame || "").trim();
  }
}

module.exports = {
  resolveCategory,
  RESOLVE_TIMEOUT_MS,
  MARKETS_NEEDING_CATEGORY,
  // Exported for tests and for a settings-change hook; not part of the
  // contract's published surface.
  CACHE_TTL_MS,
  MISS_TTL_MS,
  DEGRADED_TTL_MS,
  clearCache,
  normGame,
};
