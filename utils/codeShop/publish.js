// Code shop — approve, publish, take down (docs/code-shop/03-MARKETS.md, publish.js;
// docs/code-shop/05-REVIEW-FIXES.md R1-R4 override the older contract).
//
// This is the one module of the code shop that creates REAL marketplace offers,
// so every path below is written around one rule: a live offer must never exist
// without the MarketplaceListing row that makes our fulfillers deliver it. A
// row write that fails after the offer went live takes the offer straight back
// down.
//
// Eldorado and PlayerAuctions are published to (06-PLAYERAUCTIONS-PLAN.md C1:
// PlayerAuctions claims each order's units at the moment of sale and has no
// vault, so a sale is always tied to its unit). GGSel never says which unit it sold,
// a Listings-page delist hands its vault back as unsold, and the guardian tops
// the vault up behind the shop's back — any of which can sell one code twice —
// so a product naming GGSel is refused, and nothing here calls a GGSel
// function. Gameflip and Plati/Digiseller are blocked by the owner. The market
// list is checked against ALLOWED_MARKETS before any marketplace call, whatever
// a product or the settings say.
//
// Nothing here prints, logs or returns a code: events and Telegram lines carry
// names, counts and marketplace ids only.

const fsp = require("fs/promises");
const { checkBuyerText } = require("./textGuard");

const ALLOWED_MARKETS = Object.freeze(["eldorado", "playerauctions"]);
const ELDORADO_MIN_USD = 0.5;
// PlayerAuctions (06-PLAYERAUCTIONS-PLAN.md C2-C4): one fixed price for every
// bundle from the settings, never under its $5 minimum; titles of at most 150
// characters; the redeem guide in the 500-character offer instruction.
const PA_MIN_USD = 5;
const PA_TITLE_MAX = 150;
const PA_INSTRUCTION_MAX = 500;
// PlayerAuctions throttles writes ("Operated too frequent", code 1): waited out once.
const PA_WRITE_GAP_MS = 25000;
const PA_UNKNOWN_OUTCOME = "the outcome is unknown: check PlayerAuctions for an offer with this title before publishing again";
// A hide refused because the offer itself is no longer on sale: nothing to take
// down. Only PlayerAuctions' own answer about the OFFER counts (err.paCode is
// set, and the words name the offer): an HTTP error page, an expired session or
// a closed seller account is never read as "gone" (review, 2026-10-18), or a
// live offer would be marked delisted and left selling with no stock sync.
const PA_GONE_RE = /\boffers?\b[^.;\n]{0,30}\b(?:not found|does ?n.?t exist|no longer exists?|(?:has been |is |was )?(?:cancell?ed|removed|deleted|closed|expired|already hidden))\b|\b(?:not found|does ?n.?t exist)\b[^.;\n]{0,20}\boffers?\b/i;

const GGSEL_REFUSED = "GGSel is not used for codes yet: it never reports which code it sold, so a code could be sold twice";
// Eldorado refuses a new offer once the category's active-offer quota is used.
const OFFER_LIMIT_RE = /maximum of \d+ active offers|offer creation limits/i;
const OFFER_LIMIT_MSG = "Eldorado's offer limit for this category is full";
// A create call whose answer was lost may still have made the offer: the owner
// looks before pressing Publish again (and the scheduler never retries it, R2).
const UNKNOWN_OUTCOME = "the outcome is unknown: check Eldorado for an offer with this title before publishing again";
const ROW_NOTE = "code shop";
// publish.lastError is stored clipped to this; a repeat is compared clipped too.
const LAST_ERROR_MAX = 1000;

const errText = (err) => String((err && err.message) || err || "unknown error").slice(0, 400);
const str = (v) => (v === undefined || v === null ? "" : String(v));
const usd = (v) => "$" + (Number(v) || 0).toFixed(2);

// The price a market is given: never below the floor or the market minimum.
function priceOf(product) {
  const pr = (product && product.pricing) || {};
  const raw = Math.max(Number(pr.priceUsd) || 0, Number(pr.floorUsd) || 0, ELDORADO_MIN_USD);
  return Math.round(raw * 100) / 100;
}

// The PlayerAuctions price: the settings' one price for every bundle, never
// under PlayerAuctions' minimum.
function paPriceOf(cfg) {
  const set = Number(cfg && cfg.pricing && cfg.pricing.playerauctionsUsd);
  const raw = Math.max(Number.isFinite(set) ? set : 0, PA_MIN_USD);
  return Math.round(raw * 100) / 100;
}

// The item leaf a code bundle is filed under on PlayerAuctions. Never a root
// named for Twitch drops (these are redeem codes, not Twitch drops), never a
// sentinel row (id <= 0: PlayerAuctions refuses it), never a currency or
// hard-goods root (utils/marketplaces.js PA_ROOT_DENY), and only a cosmetic
// root, best first; its "Other ..." leaf, else its first leaf. null = none fits:
// better no listing than a misfiled one.
const PA_ROOT_DENY = /^(vc|gold|coin|credit|currenc|cash|silver|gem|token|ore|crystal|powder|twine|material|mechanical)/i;
const PA_ROOT_PREFER = [/skin|cosmetic/i, /coating|armou?r/i, /bundle|pack/i, /outfit|emote|spray|charm|banner|icon/i, /weapon/i, /^\s*(other|misc|items?)\b/i];
function codeItemLeaf(tree) {
  const rank = (name) => {
    const n = str(name).trim();
    if (/twitch\s*drops?/i.test(n) || PA_ROOT_DENY.test(n)) return -1;
    const i = PA_ROOT_PREFER.findIndex((re) => re.test(n));
    return i;
  };
  const ranked = (Array.isArray(tree) ? tree : [])
    .filter((r) => r && Number(r.id) > 0 && rank(r.name) >= 0)
    .sort((a, b) => rank(a.name) - rank(b.name));
  for (const root of ranked) {
    const subs = (Array.isArray(root.subCategorys) ? root.subCategorys : []).filter(
      (x) => x && Number(x.id) > 0 && !/twitch\s*drops?/i.test(str(x.name)),
    );
    const sub = subs.find((x) => /^\s*(other|misc|general|any)/i.test(str(x.name))) || subs[0] || null;
    return {
      rootItem: root.id,
      itemId: sub ? sub.id : root.id,
      itemPath: root.id + "|" + (sub ? sub.id : root.id),
      name: str(root.name) + (sub ? " > " + str(sub.name) : ""),
    };
  }
  return null;
}

function createPublisher(deps = {}) {
  const model = (name) => (deps.models && deps.models[name]) || require("../../models/" + name);
  const CodeProduct = () => model("CodeProduct");
  const AccountOffer = () => model("AccountOffer");
  const MarketplaceListing = () => model("MarketplaceListing");

  // Lazy, so a caller that only asks problems() never loads a marketplace.
  const mp = () => (typeof deps.mp === "function" ? deps.mp() : require("../marketplaces"));
  const stock = () => (typeof deps.stock === "function" ? deps.stock() : require("../suppliedStock"));
  let coverApi = deps.cover || null;
  const cover = () => coverApi || (coverApi = require("./cover").createCover(deps));
  let unitsApi = deps.units || null;
  const units = () => unitsApi || (unitsApi = require("./units").createUnits(deps));
  let fillApi = deps.fill || null;
  const fill = () => fillApi || (fillApi = require("./fill").createFill(deps));
  // Read at call time: the service puts its one guard on deps before any approve.
  let foreignApi = null;
  const foreign = () => deps.foreign || foreignApi || (foreignApi = require("./foreign").createForeignGuard(deps));
  const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());
  const sleep = (ms) => (typeof deps.sleep === "function" ? deps.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
  const guideFor = (gameNo, cfg) => (deps.guideFor || require("./games").guideFor)(gameNo, cfg);

  async function getConfig() {
    if (deps.config && typeof deps.config.get === "function") return deps.config.get();
    return require("./config").deepMerge(require("./config").DEFAULTS, null);
  }

  async function log(entry) {
    try {
      if (deps.events && typeof deps.events.log === "function") await deps.events.log(entry);
    } catch (err) {
      console.error("[code-shop] event not saved: " + errText(err));
    }
  }

  async function tell(text) {
    try {
      if (deps.telegram && typeof deps.telegram.send === "function") await deps.telegram.send(text);
    } catch (err) {
      console.error("[code-shop] telegram not sent: " + errText(err));
    }
  }

  async function loadProduct(id) {
    const key = id && typeof id === "object" && id._id ? id._id : id;
    if (!key) return null;
    try {
      return await CodeProduct().findById(key).lean();
    } catch (err) {
      if (err && err.name === "CastError") return null;
      throw err;
    }
  }

  // --- problems ---------------------------------------------------------------

  function problemsWith(product, cfg) {
    const p = product || {};
    const out = [];
    const slots = Array.isArray(p.slots) ? p.slots : [];
    if (!slots.length) out.push("no slots: the bundle holds no codes");

    const seen = new Set();
    const dup = new Set();
    for (const s of slots) {
      const k = str(s && s.slotKey);
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    }
    if (dup.size) out.push("the same slot is in the bundle twice (" + [...dup].join(", ") + ")");

    const t = p.texts || {};
    out.push(
      ...checkBuyerText(
        {
          title: t.title,
          description: t.description,
          deliveryTemplate: t.deliveryTemplate,
          coverTitle: t.coverTitle,
          coverServiceText: t.coverServiceText,
          coverBullets: t.coverBullets,
          labels: slots.map((s) => str(s && s.label)),
        },
        { sourceWords: cfg.sourceWords },
      ),
    );

    const pr = p.pricing || {};
    const price = Number(pr.priceUsd);
    const floor = Number(pr.floorUsd) || 0;
    if (!Number.isFinite(price)) out.push("no price set");
    else {
      if (price < ELDORADO_MIN_USD) out.push("price " + usd(price) + " is below the " + usd(ELDORADO_MIN_USD) + " market minimum");
      if (price < floor) out.push("price " + usd(price) + " is below its floor " + usd(floor));
    }

    const markets = [...new Set(Array.isArray(p.markets) ? p.markets.map(str) : [])];
    // GGSel has its own refusal: it is a real market, just not a safe one for codes.
    if (markets.includes("ggsel")) out.push(GGSEL_REFUSED);
    const blocked = markets.filter((m) => m !== "ggsel" && !ALLOWED_MARKETS.includes(m));
    if (blocked.length) {
      out.push("market not allowed: " + blocked.join(", ") + " (the code shop sells only on " + ALLOWED_MARKETS.join(" and ") + ")");
    }
    // The settings' own GGSel switch is ignored here: it can never make GGSel a
    // code shop market (config.validatePatch refuses turning it on).
    const enabled = (cfg && cfg.markets) || {};
    const allowed = markets.filter((m) => ALLOWED_MARKETS.includes(m));
    if (!markets.length) out.push("no market chosen");
    else if (allowed.length && !allowed.some((m) => enabled[m] === true)) {
      out.push("none of its markets is switched on in the code shop settings");
    }

    if (!str(p.marketGame).trim()) out.push("no marketplace game name");
    return out;
  }

  // -> [String]; empty = the product may be approved / published.
  async function problems(product) {
    return problemsWith(product, await getConfig());
  }

  // --- approve ----------------------------------------------------------------

  async function approveNow(id, { actor = "", rebalance = false, publish = true } = {}) {
    const product = await loadProduct(id);
    if (!product) return { ok: false, problems: ["product not found"] };
    const approvable = product.status === "draft" || product.status === "paused";
    if (!approvable || product.offer) {
      return {
        ok: false,
        problems: [
          product.offer && product.status === "paused"
            ? "this product was approved before: resume it instead"
            : product.offer && product.status === "draft"
              ? "this draft already has an offer"
              : "only a draft can be approved (this product is " + product.status + ")",
        ],
      };
    }
    const found = await problems(product);
    if (found.length) return { ok: false, problems: found };

    const t = product.texts || {};
    const pr = product.pricing || {};
    const slots = Array.isArray(product.slots) ? product.slots : [];
    const offer = await AccountOffer().create({
      title: t.title,
      description: t.description,
      game: product.marketGame,
      note: "code shop product " + String(product._id),
      priceUsd: Number(pr.priceUsd) || 0,
      minPriceUsd: Number(pr.floorUsd) || 0,
      status: "active",
      autoDeliver: true,
      deliveryTemplate: t.deliveryTemplate,
      coverStyle: "promo",
      coverServiceText: t.coverServiceText || "",
      coverBullets: Array.isArray(t.coverBullets) ? t.coverBullets : [],
      coverImages: slots.map((s) => str(s && s.image).trim()).filter(Boolean),
      createdBy: str(actor),
    });

    // Guarded on the state just read: a second approve racing this one must
    // not hand the product a second offer.
    const approved = await CodeProduct()
      .findOneAndUpdate(
        { _id: product._id, status: product.status, offer: null },
        {
          $set: {
            status: "active",
            offer: offer._id,
            approvedAt: new Date(now()),
            approvedBy: str(actor),
            edited: true,
          },
        },
        { returnDocument: "after" },
      )
      .lean();
    if (!approved) {
      // Ours lost: archive the offer just made so nothing is left pointing at it.
      await AccountOffer()
        .updateOne({ _id: offer._id }, { $set: { status: "archived" } })
        .catch((err) => console.error("[code-shop] orphan offer not archived: " + errText(err)));
      return { ok: false, problems: ["the product changed while it was being approved; try again"] };
    }

    // Other active products of the same game that share a slot give their
    // unsold bundles back, so the fill below can build this product too. An
    // adopted product's bundles are the owner's hand-made stock: never touched.
    let dissolved = 0;
    if (rebalance) {
      const keys = slots.map((s) => str(s && s.slotKey)).filter(Boolean);
      const others = keys.length
        ? await CodeProduct()
            .find({
              _id: { $ne: product._id },
              status: "active",
              origin: { $ne: "adopted" },
              gameNo: product.gameNo,
              "slots.slotKey": { $in: keys },
            })
            .lean()
        : [];
      for (const other of others) {
        try {
          const r = await units().dissolve(other, { reason: "moved to " + str(product.name) });
          dissolved += Number(r && r.dissolved) || 0;
        } catch (err) {
          await log({ level: "warn", kind: "approve", product: other._id, msg: "Could not free the bundles of " + str(other.name) + ": " + errText(err) });
        }
      }
    }

    // The foreign-stock guard runs before any code goes into a bundle (after
    // the rebalance, so the codes it just freed are checked too). If it fails
    // the product stays approved, but nothing is built or published: the next
    // tick runs the guard again and does both.
    let guard;
    try {
      const summary = await foreign().run();
      guard = { ...(summary && typeof summary === "object" ? summary : {}), ok: true };
    } catch (err) {
      guard = { ok: false, error: errText(err) };
    }

    if (!guard.ok) {
      const note = "Approved, but no bundles were built and nothing was published: the foreign-stock guard failed (" + guard.error + "); the next tick runs it again, then builds and publishes";
      await log({
        level: "warn",
        kind: "approve",
        product: product._id,
        msg: "Approved " + str(product.name) + ", but no bundles were built: the foreign-stock guard failed (" + guard.error + ")",
        data: { built: 0, dissolved, actor: str(actor) },
      });
      return {
        ok: true,
        product: await loadProduct(product._id),
        built: 0,
        dissolved,
        foreign: guard,
        fill: { built: 0, failed: 0, byProduct: {}, skipped: "foreign guard failed" },
        publish: null,
        note,
      };
    }

    // Only this product: the other products' stock is the tick's business.
    let filled;
    try {
      filled = await fill().run({ force: true, productIds: [String(product._id)] });
    } catch (err) {
      filled = { built: 0, failed: 0, byProduct: {}, error: errText(err) };
      await log({ level: "warn", kind: "approve", product: product._id, msg: "Building bundles after approving " + str(product.name) + " failed: " + errText(err) });
    }
    const byProduct = (filled && filled.byProduct) || {};
    const built = Number(byProduct[String(product._id)]) || 0;

    await log({
      kind: "approve",
      product: product._id,
      msg: "Approved " + str(product.name) + " (" + built + " bundles built" + (dissolved ? ", " + dissolved + " moved from other products" : "") + ")",
      data: { built, dissolved, actor: str(actor) },
    });

    const published = publish ? await publishNow(product._id, { actor }) : null;
    return { ok: true, product: await loadProduct(product._id), built, dissolved, foreign: guard, fill: filled, publish: published };
  }

  // --- publish ----------------------------------------------------------------

  function rowBase(product, market, made, price) {
    const t = product.texts || {};
    return {
      set: null,
      accountOffer: product.offer,
      origin: "manual",
      accountId: "",
      accountLogin: "",
      units: [],
      marketplace: market,
      externalId: str(made.externalId),
      externalNode: "",
      url: str(made.url),
      title: str(t.title),
      description: str(t.description),
      price,
      status: "active",
      note: ROW_NOTE,
    };
  }

  // Eldorado answered and said no (a 4xx, or the offer quota): nothing was
  // made. Anything else — a timeout, a dropped connection, a 5xx, an error
  // with no answer at all — may have lost the answer to a create that worked.
  function refusedOutright(err, msg) {
    const status = Number((err && err.status) || (err && err.response && err.response.status));
    if (status >= 400 && status < 500) return true;
    return /\(HTTP 4\d\d\)/.test(msg);
  }

  async function publishEldorado(product, { shelf, price, coverPath }) {
    const t = product.texts || {};
    const path = await coverPath();
    let made;
    try {
      made = await mp().eldoradoPublish({
        game: product.marketGame,
        title: t.title,
        description: t.description,
        priceUsd: price,
        quantity: shelf,
        minQuantity: 1,
        coverImagePath: path,
      });
    } catch (err) {
      const msg = errText(err);
      if (OFFER_LIMIT_RE.test(msg)) return { market: "eldorado", ok: false, error: OFFER_LIMIT_MSG };
      return { market: "eldorado", ok: false, error: refusedOutright(err, msg) ? msg : msg + "; " + UNKNOWN_OUTCOME };
    }
    const externalId = str(made && made.externalId);
    if (!externalId) {
      return { market: "eldorado", ok: false, error: "Eldorado answered without an offer id; " + UNKNOWN_OUTCOME };
    }
    try {
      const row = await MarketplaceListing().create(rowBase(product, "eldorado", made, price));
      return { market: "eldorado", ok: true, externalId, url: str(made.url), listingId: String(row._id), quantity: shelf };
    } catch (err) {
      // A live offer with no row is an order nobody delivers: take it down.
      const why = errText(err);
      try {
        await mp().eldoradoDelist(externalId);
        return { market: "eldorado", ok: false, externalId, error: "listing row not saved (" + why + "); the new Eldorado offer was paused" };
      } catch (err2) {
        return {
          market: "eldorado",
          ok: false,
          externalId,
          error: "listing row not saved (" + why + ") and the new Eldorado offer " + externalId + " could NOT be paused (" + errText(err2) + "): pause it on Eldorado by hand",
        };
      }
    }
  }

  // The title as sent: PlayerAuctions shows it folded (a "|" may read "-").
  const titleSent = (title) => " (title sent: " + JSON.stringify(str(title)) + ")";

  // Why PlayerAuctions would not deliver an order right now ("" = it would).
  // A live offer whose orders nobody delivers is money taken (06 plan, review).
  function paDeliveryProblem() {
    let af;
    let al;
    try {
      af = (typeof deps.autoFarm === "function" ? deps.autoFarm() : require("../settings").getAutoFarm()) || {};
      al =
        (typeof deps.accountListingSettings === "function"
          ? deps.accountListingSettings()
          : require("../settings").getAccountListingSettings()) || {};
    } catch (err) {
      return "its delivery settings could not be read (" + errText(err) + ")";
    }
    if (af.playerauctionsAutoDeliver !== true) return "PlayerAuctions auto-delivery is off (autoFarm.playerauctionsAutoDeliver)";
    if (af.playerauctionsDeliverDryRun !== false) return "PlayerAuctions delivery is a dry run (autoFarm.playerauctionsDeliverDryRun)";
    if (af.playerauctionsSyncStock === false) return "PlayerAuctions stock sync is off (autoFarm.playerauctionsSyncStock)";
    if (!al.enabled || !al.autoDeliver) return "account-listing delivery is off in the settings";
    return "";
  }

  // Each listing of one shelf advertises its share (S4). After one market's
  // listing goes up, the OTHER market's live listings are given their new,
  // smaller share at once rather than at their next stock sync (Eldorado 15
  // min, PlayerAuctions 30): until then both together would advertise more
  // than the shelf holds. Never the listing just made (a PlayerAuctions write
  // right after its create would hit the write throttle). Best effort: a failed
  // push is logged and the market's own sync corrects it.
  async function pushShares(product, justMade) {
    const other = justMade === "playerauctions" ? "eldorado" : "playerauctions";
    let rows;
    try {
      rows = await MarketplaceListing().find({ accountOffer: product.offer, marketplace: other, status: "active" });
    } catch (err) {
      await log({ level: "warn", kind: "publish", product: product._id, msg: "Could not read the " + other + " listings to share the stock: " + errText(err) });
      return;
    }
    for (const row of rows || []) {
      try {
        if (other === "eldorado") {
          const q = Number(await stock().stockFor(typeof row.toObject === "function" ? row.toObject() : row)) || 0;
          // 0 is left to the Eldorado stock sync, which pauses rather than pushes 0.
          if (q >= 1) await mp().eldoradoSetQuantity(row.externalId, q);
        } else {
          const sync = typeof deps.paSyncStock === "function" ? deps.paSyncStock : require("../playerauctionsFulfiller").syncStock;
          await sync(row);
        }
      } catch (err) {
        await log({
          level: "warn",
          kind: "publish",
          product: product._id,
          msg: "The " + other + " offer " + str(row.externalId) + " still shows its old stock (" + errText(err) + "); its stock sync corrects it",
        });
      }
    }
  }

  // PlayerAuctions (06-PLAYERAUCTIONS-PLAN.md C3/C4). The offer starts with
  // the share of the shelf it will have once its row exists; both stock syncs
  // keep the shares right afterwards.
  async function publishPlayerAuctions(product, { share, price, coverPath, cfg }) {
    const market = "playerauctions";
    const t = product.texts || {};
    const m = mp();
    const game = await m.playerauctionsResolveGame(product.marketGame);
    if (!game || !game.gameId) return { market, ok: false, error: "PlayerAuctions has no game called " + str(product.marketGame) };
    const leaf = codeItemLeaf(await m.playerauctionsItemCategories(game.gameId));
    if (!leaf) return { market, ok: false, error: "PlayerAuctions has no item category to file codes under for " + str(game.gameName || product.marketGame) };
    const { fitTitle, marketInstruction } = require("./texts");
    const title = fitTitle(t.title, PA_TITLE_MAX);
    const slots = Array.isArray(product.slots) ? product.slots : [];
    const opts = {
      gameId: game.gameId,
      itemPath: leaf.itemPath,
      rootItem: leaf.rootItem,
      itemId: leaf.itemId,
      title,
      description: t.description,
      instruction: marketInstruction(guideFor(product.gameNo, cfg), PA_INSTRUCTION_MAX),
      priceUsd: price,
      itemsPerUnit: slots.length || 1,
      totalUnit: share,
      minUnitPerOrder: 1,
      deliveryGuarantee: m.PA_DELIVERY && m.PA_DELIVERY.min20,
      coverImagePath: await coverPath(),
    };
    let made;
    try {
      try {
        made = await m.playerauctionsPublish(opts);
      } catch (err) {
        // The write throttle said no: nothing was made. Wait it out once.
        if (!(err && err.retryable)) throw err;
        await sleep(PA_WRITE_GAP_MS);
        made = await m.playerauctionsPublish(opts);
      }
    } catch (err) {
      const msg = errText(err);
      // PlayerAuctions said no (isSuccess false, or a 4xx): nothing was made.
      const refused = (err && err.paCode !== undefined) || (Number(err && err.status) >= 400 && Number(err && err.status) < 500);
      return { market, ok: false, error: refused ? msg : msg + "; " + PA_UNKNOWN_OUTCOME + titleSent(title) };
    }
    const externalId = str(made && (made.offerId || made.id));
    if (!externalId) return { market, ok: false, error: "PlayerAuctions answered without an offer id; " + PA_UNKNOWN_OUTCOME + titleSent(title) };
    try {
      const row = await MarketplaceListing().create({
        ...rowBase(product, market, { externalId, url: made.url }, price),
        title,
        qtyTarget: share,
      });
      return { market, ok: true, externalId, url: str(made.url), listingId: String(row._id), quantity: share, category: leaf.name };
    } catch (err) {
      // A live offer with no row is an order nobody delivers: cancel it.
      const why = errText(err);
      try {
        await m.playerauctionsCancelOffer(externalId);
        return { market, ok: false, externalId, error: "listing row not saved (" + why + "); the new PlayerAuctions offer was cancelled" };
      } catch (err2) {
        return {
          market,
          ok: false,
          externalId,
          error: "listing row not saved (" + why + ") and the new PlayerAuctions offer " + externalId + " could NOT be cancelled (" + errText(err2) + "): cancel it on PlayerAuctions by hand",
        };
      }
    }
  }

  // One event per market; Telegram is sent once per publish, by publishNow.
  async function reportMarket(product, r, actor) {
    const name = str(product.name);
    const msg = r.error
      ? "Publishing " + name + " to " + r.market + " failed: " + r.error
      : r.skipped
        ? "Not published to " + r.market + ": " + r.skipped
        : "Published " + name + " to " + r.market + " (" + r.quantity + " in stock)";
    await log({
      level: r.error ? "error" : "info",
      kind: "publish",
      product: product._id,
      msg,
      data: { market: r.market, externalId: r.externalId || "", skipped: r.skipped || "", actor: str(actor) },
    });
  }

  const clip = (v) => str(v).slice(0, LAST_ERROR_MAX);

  async function stampPublish(product, lastError) {
    try {
      await CodeProduct().updateOne(
        { _id: product._id },
        { $set: { "publish.lastError": clip(lastError), "publish.lastAttemptAt": new Date(now()) } },
      );
    } catch (err) {
      console.error("[code-shop] publish result not saved: " + errText(err));
    }
  }

  // A failure is told once: the same error as the product's previous attempt
  // (an owner pressing Publish again on a known problem) sends nothing.
  async function tellFailure(previous, lastError, text) {
    if (!lastError || clip(lastError) === clip(previous)) return;
    await tell("Code shop: " + text);
  }

  // -> { results: [{ market, ok, skipped?, externalId?, url?, listingId?, error? }], error? }
  // `ok` is true only for a listing created by this call; a skip is ok:false
  // with `skipped` (nothing went wrong, nothing went up either).
  // `markets` (the scheduler's list of markets a product never had a listing
  // on): only those are published, never another market whose listing was
  // taken down (R2). Absent: every market of the product, as before.
  async function publishNow(id, { actor = "", markets = null } = {}) {
    const product = await loadProduct(id);
    if (!product) return { results: [], error: "product not found" };
    if (product.status !== "active" || !product.offer) {
      return { results: [], error: "only an approved, active product is published (this one is " + product.status + ")" };
    }
    const previous = str(product.publish && product.publish.lastError);
    const cfg = await getConfig();
    const found = problemsWith(product, cfg);
    if (found.length) {
      const error = "not published: " + found.join("; ");
      await stampPublish(product, error);
      await log({ level: "error", kind: "publish", product: product._id, msg: str(product.name) + " " + error });
      await tellFailure(previous, error, str(product.name) + " " + error);
      return { results: [], error };
    }

    const enabled = cfg.markets || {};
    const results = [];
    // One cover per call, shared by the markets, deleted in `finally`.
    let coverJob = null;
    const coverPath = () => coverJob || (coverJob = Promise.resolve().then(() => cover().build(product)));
    try {
      const only = Array.isArray(markets) ? new Set(markets.map(str)) : null;
      const named = [...new Set((Array.isArray(product.markets) ? product.markets : []).map(str))].filter((m) => !only || only.has(m));
      // Eldorado first: a PlayerAuctions listing then starts with its share beside it (S4).
      const ordered = [...ALLOWED_MARKETS.filter((m) => named.includes(m)), ...named.filter((m) => !ALLOWED_MARKETS.includes(m))];
      for (const market of ordered) {
        let r;
        if (!ALLOWED_MARKETS.includes(market)) {
          r = { market, ok: false, skipped: "not a code shop market" };
        } else if (enabled[market] !== true) {
          r = { market, ok: false, skipped: "switched off in the code shop settings" };
        } else {
          try {
            r = await publishOne(product, market, coverPath, cfg);
          } catch (err) {
            r = { market, ok: false, error: errText(err) };
          }
        }
        results.push(r);
        await reportMarket(product, r, actor);
      }
    } finally {
      if (coverJob) {
        const file = await coverJob.catch(() => null);
        if (file) await fsp.unlink(file).catch(() => {});
      }
    }

    const lastError = results
      .filter((r) => r.error)
      .map((r) => r.market + ": " + r.error)
      .join("; ");
    await stampPublish(product, lastError);
    await tellFailure(previous, lastError, "Publishing " + str(product.name) + " failed: " + lastError);
    return { results };
  }

  async function publishOne(product, market, coverPath, cfg) {
    // Never anything but a code shop market, even if a caller got past the checks above.
    if (!ALLOWED_MARKETS.includes(market)) return { market, ok: false, skipped: "not a code shop market" };
    const live = await MarketplaceListing().exists({ accountOffer: product.offer, marketplace: market, status: "active" });
    if (live) return { market, ok: false, skipped: "already live" };
    if (market === "playerauctions") {
      // Checked before any PlayerAuctions call (06 plan, review).
      if (!require("./config").paAllowsGame(cfg, product.gameNo)) {
        return { market, ok: false, error: "PlayerAuctions is not used for this game's codes (settings: playerauctionsGames)" };
      }
      const why = paDeliveryProblem();
      if (why) return { market, ok: false, error: "not published on PlayerAuctions, it would not deliver: " + why };
    }
    const shelf = Number(await stock().shelfFor(product.offer)) || 0;
    if (shelf < 1) return { market, ok: false, skipped: "no stock yet" };
    // The share this new listing will have of the one shelf (S4): it is not a
    // row yet, so it counts as the last sharer and takes the smallest share.
    // Alone on the shelf it is the whole shelf, as before.
    const st = stock();
    const sharers = await MarketplaceListing()
      .find(
        { accountOffer: product.offer, status: "active", marketplace: { $nin: st.NON_SHARING_MARKETS || ["zeusx"] } },
        { _id: 1 },
      )
      .lean();
    const share = Number(st.shareOfShelf(shelf, "", (sharers || []).map((r) => String(r._id)))) || 0;
    if (share < 1) return { market, ok: false, skipped: "no stock left for another market yet" };
    const r =
      market === "eldorado"
        ? await publishEldorado(product, { shelf: share, price: priceOf(product), coverPath })
        : await publishPlayerAuctions(product, { share, price: paPriceOf(cfg), coverPath, cfg });
    if (r && r.ok && (sharers || []).length) await pushShares(product, market);
    return r;
  }

  // --- take down --------------------------------------------------------------

  async function takeDownEldorado(product) {
    const out = { delisted: 0, errors: [] };
    if (!product.offer) return out;
    const rows = await MarketplaceListing()
      .find({ accountOffer: product.offer, marketplace: "eldorado", status: "active" })
      .lean();
    for (const row of rows) {
      let status = "delisted";
      let note = str(row.note);
      try {
        await mp().eldoradoDelist(row.externalId);
      } catch (err) {
        const msg = errText(err);
        const m = mp();
        const outcome = typeof m.delistOutcome === "function" ? m.delistOutcome(msg) : "";
        if (!outcome) {
          out.errors.push("Eldorado offer " + row.externalId + ": " + msg);
          await MarketplaceListing()
            .updateOne({ _id: row._id }, { $set: { lastError: msg } })
            .catch(() => {});
          continue;
        }
        // Already off sale (gone) or sold out: the goal is met either way.
        if (outcome === "sold") status = "sold";
        note = (note ? note + " " : "") + "gone from the marketplace";
      }
      const res = await MarketplaceListing().updateOne(
        { _id: row._id, status: "active" },
        { $set: { status, lastError: "", note } },
      );
      out.delisted += Number(res && res.modifiedCount) || 0;
    }
    return out;
  }

  // PlayerAuctions rows (C6): hidden (reversible on PlayerAuctions' side) and
  // marked delisted; a resume publishes a fresh offer, as on Eldorado.
  async function takeDownPlayerAuctions(product) {
    const out = { delisted: 0, errors: [] };
    if (!product.offer) return out;
    const rows = await MarketplaceListing()
      .find({ accountOffer: product.offer, marketplace: "playerauctions", status: "active" })
      .lean();
    for (const row of rows) {
      let note = "hidden by the code shop";
      try {
        try {
          await mp().playerauctionsHide(row.externalId);
        } catch (err) {
          // The write throttle said no: nothing changed. Wait it out once.
          if (!(err && err.retryable)) throw err;
          await sleep(PA_WRITE_GAP_MS);
          await mp().playerauctionsHide(row.externalId);
        }
      } catch (err) {
        const msg = errText(err);
        // Already off sale (cancelled by hand, ended, gone): the goal is met.
        // Only PlayerAuctions' own words count, never our "... offer failed" label.
        const said = msg.replace(/^[^:]*?failed(?: \((?:code|HTTP)[^)]*\))?:\s*/i, "");
        const gone = err && err.paCode !== undefined && err.paCode !== 1 && PA_GONE_RE.test(said);
        if (!gone) {
          out.errors.push("PlayerAuctions offer " + row.externalId + ": " + msg);
          await MarketplaceListing()
            .updateOne({ _id: row._id }, { $set: { lastError: msg } })
            .catch(() => {});
          continue;
        }
        note = "gone from the marketplace";
      }
      const res = await MarketplaceListing().updateOne(
        { _id: row._id, status: "active" },
        { $set: { status: "delisted", lastError: "", note: (str(row.note) ? str(row.note) + " " : "") + note } },
      );
      out.delisted += Number(res && res.modifiedCount) || 0;
    }
    return out;
  }

  async function countActive(product, market) {
    if (!product.offer) return 0;
    return MarketplaceListing().countDocuments({ accountOffer: product.offer, marketplace: market, status: "active" });
  }

  // The shop never puts an offer on GGSel, but the Listings page can list any
  // offer there by hand. Such a row is only COUNTED here (a database read, no
  // GGSel call): pause says it is still live, retire refuses while it is.
  const GGSEL_BY_HAND = "GGSel listings are not taken down here: delist them from the Listings page, which empties the vault";

  async function pauseNow(id, { actor = "" } = {}) {
    const product = await loadProduct(id);
    if (!product) return { ok: false, error: "product not found" };
    if (product.status !== "active" && product.status !== "paused") {
      return { ok: false, error: "a " + product.status + " product cannot be paused" };
    }
    const eld = await takeDownEldorado(product);
    const pa = await takeDownPlayerAuctions(product);
    const down = { delisted: eld.delisted + pa.delisted, errors: [...eld.errors, ...pa.errors] };
    await CodeProduct().updateOne({ _id: product._id, status: { $in: ["active", "paused"] } }, { $set: { status: "paused" } });
    const ggselLive = await countActive(product, "ggsel");
    const msg =
      "Paused " +
      str(product.name) +
      ": " +
      eld.delisted +
      " Eldorado and " +
      pa.delisted +
      " PlayerAuctions listing(s) taken down" +
      (down.errors.length ? ", " + down.errors.length + " could not be: " + down.errors.join("; ") : "") +
      (ggselLive ? "; " + ggselLive + " GGSel listing(s) still live" : "");
    await log({ level: down.errors.length ? "error" : "info", kind: "pause", product: product._id, msg, data: { actor: str(actor) } });
    if (down.errors.length) await tell("Code shop: " + msg);
    return {
      ok: down.errors.length === 0,
      product: await loadProduct(product._id),
      delisted: down.delisted,
      errors: down.errors,
      ggselLive,
      note: ggselLive ? GGSEL_BY_HAND : "",
    };
  }

  async function resumeNow(id, { actor = "" } = {}) {
    const product = await loadProduct(id);
    if (!product) return { ok: false, error: "product not found" };
    if (product.status !== "paused") {
      return { ok: false, error: "only a paused product can be resumed (this one is " + product.status + ")" };
    }
    if (!product.offer) return { ok: false, error: "this product was never approved: approve it instead" };
    const found = await problems(product);
    if (found.length) return { ok: false, problems: found };
    const res = await CodeProduct().updateOne(
      { _id: product._id, status: "paused", offer: product.offer },
      { $set: { status: "active" } },
    );
    if (!(Number(res && res.modifiedCount) > 0)) return { ok: false, error: "the product changed; try again" };
    await log({ kind: "resume", product: product._id, msg: "Resumed " + str(product.name), data: { actor: str(actor) } });
    const published = await publishNow(product._id, { actor });
    return { ok: true, product: await loadProduct(product._id), publish: published };
  }

  async function retireNow(id, { actor = "" } = {}) {
    const product = await loadProduct(id);
    if (!product) return { ok: false, error: "product not found" };
    if (product.status === "retired") return { ok: true, already: true, product };
    const ggselRefusal = {
      ok: false,
      error: "A GGSel listing of this product is still live. " + GGSEL_BY_HAND + ", then retire it.",
    };
    if (await countActive(product, "ggsel")) return ggselRefusal;

    let paused = null;
    if (product.status === "active" || product.status === "paused") {
      paused = await pauseNow(product._id, { actor });
      if (!paused.ok) {
        const why = (paused.errors || []).join("; ") || paused.error || "the listings could not be taken down";
        return { ok: false, error: "not retired: " + why, pause: paused };
      }
      // A publish that raced the check above could have put one up since.
      if (await countActive(product, "ggsel")) return { ...ggselRefusal, pause: paused };
    }

    let dissolved = 0;
    if (product.offer) {
      try {
        const r = await units().dissolve(paused && paused.product ? paused.product : product, { reason: "retired" });
        dissolved = Number(r && r.dissolved) || 0;
      } catch (err) {
        return { ok: false, error: "not retired: its bundles could not be taken apart (" + errText(err) + ")", pause: paused };
      }
    }

    await CodeProduct().updateOne(
      { _id: product._id, status: { $ne: "retired" } },
      { $set: { status: "retired", retiredAt: new Date(now()) } },
    );
    await log({
      kind: "retire",
      product: product._id,
      msg: "Retired " + str(product.name) + (dissolved ? ": " + dissolved + " bundles taken apart, their codes back in stock" : ""),
      data: { dissolved, actor: str(actor) },
    });
    return { ok: true, product: await loadProduct(product._id), dissolved, pause: paused };
  }

  // --- one product at a time ---------------------------------------------------

  // The scheduler and the HTTP routes share ONE publisher, so two writers can
  // reach the same product at once — and "already live" is a read, not a
  // lock: two publishes racing it would both put an Eldorado offer up. Every
  // public action on a product therefore waits for the one before it on the
  // SAME product id; other products run in parallel. Internal calls (approve
  // -> publish, resume -> publish, retire -> pause) use the *Now functions
  // directly: they already hold the product's turn, and waiting on it again
  // would wait forever.
  const chains = new Map(); // String(productId) -> tail promise (never rejects)

  function keyOf(id) {
    const v = id && typeof id === "object" && id._id ? id._id : id;
    return str(v);
  }

  function serial(id, fn) {
    const key = keyOf(id);
    const prev = chains.get(key) || Promise.resolve();
    // `prev` never rejects (see `tail`), so a failed action never jams the chain.
    const run = prev.then(() => fn());
    const tail = run.then(
      () => {},
      () => {},
    );
    chains.set(key, tail);
    tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  }

  return {
    problems,
    approve: (id, opts) => serial(id, () => approveNow(id, opts)),
    publishProduct: (id, opts) => serial(id, () => publishNow(id, opts)),
    pause: (id, opts) => serial(id, () => pauseNow(id, opts)),
    resume: (id, opts) => serial(id, () => resumeNow(id, opts)),
    retire: (id, opts) => serial(id, () => retireNow(id, opts)),
    // How many products have an action running or waiting (tests, health).
    busy: () => chains.size,
  };
}

module.exports = {
  createPublisher,
  ALLOWED_MARKETS,
  ELDORADO_MIN_USD,
  GGSEL_REFUSED,
  OFFER_LIMIT_MSG,
  UNKNOWN_OUTCOME,
  PA_MIN_USD,
  PA_TITLE_MAX,
  PA_UNKNOWN_OUTCOME,
  priceOf,
  paPriceOf,
  codeItemLeaf,
};
