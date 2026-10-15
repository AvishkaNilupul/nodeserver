// Code shop — approve, publish, take down (docs/code-shop/03-MARKETS.md, publish.js).
//
// This is the one module of the code shop that creates REAL marketplace offers,
// so every path below is written around one rule: a live offer must never exist
// without the MarketplaceListing row that makes our fulfillers deliver it. A
// row write that fails after the offer went live takes the offer straight back
// down (Eldorado) or takes it down AND holds its codes out of stock (GGSel: the
// codes already sit in GGSel's own vault, where nothing of ours can prove them
// unsold).
//
// Only Eldorado and GGSel are ever named here. Gameflip and Plati/Digiseller are
// blocked by the owner, and the market list is checked against ALLOWED_MARKETS
// before any marketplace call, whatever a product or the settings say.
//
// Nothing here prints, logs or returns a code: events and Telegram lines carry
// names, counts and marketplace ids only.

const fsp = require("fs/promises");
const { checkBuyerText } = require("./textGuard");

const ALLOWED_MARKETS = Object.freeze(["eldorado", "ggsel"]);
const ELDORADO_MIN_USD = 0.5;
const DEFAULT_VAULT_SIZE = 5;

// Eldorado refuses a new offer once the category's active-offer quota is used.
const OFFER_LIMIT_RE = /maximum of \d+ active offers|offer creation limits/i;
const OFFER_LIMIT_MSG = "Eldorado's offer limit for this category is full";
const HELD_IN_VAULT = "left in a GGSel vault by a failed publish";
const ROW_NOTE = "code shop";

const errText = (err) => String((err && err.message) || err || "unknown error").slice(0, 400);
const str = (v) => (v === undefined || v === null ? "" : String(v));
const usd = (v) => "$" + (Number(v) || 0).toFixed(2);

// The price a market is given: never below the floor or the market minimum.
function priceOf(product) {
  const pr = (product && product.pricing) || {};
  const raw = Math.max(Number(pr.priceUsd) || 0, Number(pr.floorUsd) || 0, ELDORADO_MIN_USD);
  return Math.round(raw * 100) / 100;
}

function createPublisher(deps = {}) {
  const model = (name) => (deps.models && deps.models[name]) || require("../../models/" + name);
  const CodeProduct = () => model("CodeProduct");
  const CodeStock = () => model("CodeStock");
  const AccountOffer = () => model("AccountOffer");
  const MarketplaceListing = () => model("MarketplaceListing");

  // Lazy, so a caller that only asks problems() never loads a marketplace.
  const mp = () => (typeof deps.mp === "function" ? deps.mp() : require("../marketplaces"));
  const stock = () => (typeof deps.stock === "function" ? deps.stock() : require("../suppliedStock"));
  const category = () => (typeof deps.category === "function" ? deps.category() : require("../listingCategory"));
  let coverApi = deps.cover || null;
  const cover = () => coverApi || (coverApi = require("./cover").createCover(deps));
  let unitsApi = deps.units || null;
  const units = () => unitsApi || (unitsApi = require("./units").createUnits(deps));
  let fillApi = deps.fill || null;
  const fill = () => fillApi || (fillApi = require("./fill").createFill(deps));
  const guideFor = deps.guideFor || require("./games").guideFor;
  const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());

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

    const markets = Array.isArray(p.markets) ? p.markets.map(str) : [];
    const blocked = markets.filter((m) => !ALLOWED_MARKETS.includes(m));
    if (blocked.length) {
      out.push("market not allowed: " + blocked.join(", ") + " (the code shop sells only on " + ALLOWED_MARKETS.join(" and ") + ")");
    }
    const enabled = (cfg && cfg.markets) || {};
    const live = markets.filter((m) => ALLOWED_MARKETS.includes(m) && enabled[m] === true);
    if (!live.length) {
      out.push(markets.length ? "none of its markets is switched on in the code shop settings" : "no market chosen");
    }

    if (!str(p.marketGame).trim()) out.push("no marketplace game name");
    return out;
  }

  // -> [String]; empty = the product may be approved / published.
  async function problems(product) {
    return problemsWith(product, await getConfig());
  }

  // --- approve ----------------------------------------------------------------

  async function approve(id, { actor = "", rebalance = false, publish = true } = {}) {
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
    // unsold bundles back, so the fill below can build this product too.
    let dissolved = 0;
    if (rebalance) {
      const keys = slots.map((s) => str(s && s.slotKey)).filter(Boolean);
      const others = keys.length
        ? await CodeProduct()
            .find({
              _id: { $ne: product._id },
              status: "active",
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

    let filled;
    try {
      filled = await fill().run({ force: true });
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

    const published = publish ? await publishProduct(product._id, { actor }) : null;
    return { ok: true, product: await loadProduct(product._id), built, dissolved, fill: filled, publish: published };
  }

  // --- publish ----------------------------------------------------------------

  // Rows of THIS product's units go to `held`: their codes may be in a platform
  // vault, so nothing may ever put them back on sale.
  async function holdUnitRows(unitIds, why) {
    const at = new Date(now());
    const rows = await CodeStock()
      .find({ unit: { $in: unitIds }, state: { $nin: ["sold", "dead", "held"] } }, { _id: 1, state: 1 })
      .lean();
    let held = 0;
    for (const r of rows) {
      const res = await CodeStock().updateOne(
        { _id: r._id, state: r.state },
        {
          $set: { state: "held", problem: why, wasFed: true },
          $push: { history: { $each: [{ at, from: r.state, to: "held", why }], $slice: -20 } },
        },
      );
      held += Number(res && res.modifiedCount) || 0;
    }
    return held;
  }

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
      return { market: "eldorado", ok: false, error: OFFER_LIMIT_RE.test(msg) ? OFFER_LIMIT_MSG : msg };
    }
    const externalId = str(made && made.externalId);
    if (!externalId) {
      return { market: "eldorado", ok: false, error: "Eldorado answered without an offer id: check Eldorado for a new offer before publishing again" };
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

  async function publishGgsel(product, cfg, { shelf, price, coverPath }) {
    if (!mp().ggselTakesNewStock()) return { market: "ggsel", ok: false, skipped: "GGSel takes no new stock" };
    const res = await category().resolveCategory("ggsel", product.marketGame);
    const categoryId = res && res.ok && res.value ? res.value.categoryId : null;
    if (!categoryId) {
      return { market: "ggsel", ok: false, error: "no GGSel category for " + str(product.marketGame) + (res && res.reason ? ": " + res.reason : "") };
    }
    // Before the claim: a cover that cannot be built then needs no hand-back.
    const path = await coverPath();

    const size = Math.floor(Number(product.ggsel && product.ggsel.vaultSize));
    const vault = Number.isFinite(size) ? size : DEFAULT_VAULT_SIZE;
    if (vault < 1) return { market: "ggsel", ok: false, skipped: "GGSel vault size is 0" };
    const qty = Math.min(vault, shelf);

    const claimed = (await stock().claimForListing(product.offer, qty, { market: "ggsel" })) || [];
    if (!claimed.length) return { market: "ggsel", ok: false, skipped: "no bundle could be claimed" };
    const ids = claimed.map((c) => c.ledgerId);
    const handBack = async (error) => {
      try {
        await stock().releaseClaim(ids);
        return { market: "ggsel", ok: false, error };
      } catch (err) {
        return { market: "ggsel", ok: false, error: error + " (and " + ids.length + " bundles could not be put back on the shelf: " + errText(err) + ")" };
      }
    };

    // From here until GGSel answers, any failure hands the claim back: nothing
    // has left our hands yet.
    let texts;
    try {
      const offerDoc = await AccountOffer().findById(product.offer).lean();
      if (!offerDoc) return handBack("the product's offer is missing");
      texts = claimed.map((c) => str(stock().deliveryText(c, offerDoc)));
    } catch (err) {
      return handBack(errText(err));
    }
    // A unit with no codes would sell an empty message.
    if (claimed.some((c, i) => !texts[i].trim() || !str(c && c.password).trim())) {
      return handBack("a bundle has no delivery text; nothing was published");
    }

    const t = product.texts || {};
    let made;
    try {
      const guide = guideFor(product.gameNo, cfg) || {};
      made = await mp().ggselPublish({
        title: t.title,
        description: t.description,
        priceUsd: price,
        categoryId,
        quantity: texts.length,
        delivery: "auto",
        instructions: guide.deliveryHelp,
        coverImagePath: path,
        products: texts,
      });
    } catch (err) {
      return handBack(errText(err));
    }

    const externalId = str(made && made.externalId);
    if (!externalId) {
      // An offer may exist with our codes in its vault and we cannot name it.
      const held = await holdUnitRows(ids, HELD_IN_VAULT);
      return {
        market: "ggsel",
        ok: false,
        error: "GGSel answered without an offer id: the codes may be in a GGSel vault, " + held + " codes held out of stock — check GGSel by hand",
      };
    }

    let row;
    try {
      const at = new Date(now());
      row = await MarketplaceListing().create({
        ...rowBase(product, "ggsel", made, price),
        autoDeliver: true,
        qtyTarget: qty,
        units: claimed.map((c) => ({
          contentId: String(c.ledgerId),
          accountId: "",
          login: str(c.login),
          addedAt: at,
          deliveredAt: null,
          orderId: "",
        })),
      });
    } catch (err) {
      // The codes are in GGSel's vault: pause the offer, KEEP the claim, and
      // hold the codes — a vault release can never prove them unsold.
      const why = errText(err);
      let pulled = "";
      try {
        await mp().ggselDelist(externalId);
        pulled = "the GGSel offer was paused";
      } catch (err2) {
        pulled = "the GGSel offer " + externalId + " could NOT be paused (" + errText(err2) + "): pause it on GGSel by hand";
      }
      let held = 0;
      try {
        held = await holdUnitRows(ids, HELD_IN_VAULT);
      } catch (err3) {
        console.error("[code-shop] GGSel codes not marked held: " + errText(err3));
      }
      return {
        market: "ggsel",
        ok: false,
        externalId,
        error: "listing row not saved (" + why + "); " + pulled + "; " + held + " codes held out of stock (they stay in its vault)",
      };
    }

    try {
      await stock().markFed(ids, { listing: row._id, market: "ggsel" });
    } catch (err) {
      await log({ level: "warn", kind: "publish", product: product._id, msg: "GGSel bundles not marked as in the vault: " + errText(err) });
    }
    return { market: "ggsel", ok: true, externalId, url: str(made.url), listingId: String(row._id), quantity: texts.length };
  }

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
    if (r.error) await tell("Code shop: " + msg);
  }

  async function stampPublish(product, lastError) {
    try {
      await CodeProduct().updateOne(
        { _id: product._id },
        { $set: { "publish.lastError": str(lastError).slice(0, 1000), "publish.lastAttemptAt": new Date(now()) } },
      );
    } catch (err) {
      console.error("[code-shop] publish result not saved: " + errText(err));
    }
  }

  // -> { results: [{ market, ok, skipped?, externalId?, url?, listingId?, error? }], error? }
  // `ok` is true only for a listing created by this call; a skip is ok:false
  // with `skipped` (nothing went wrong, nothing went up either).
  async function publishProduct(id, { actor = "" } = {}) {
    const product = await loadProduct(id);
    if (!product) return { results: [], error: "product not found" };
    if (product.status !== "active" || !product.offer) {
      return { results: [], error: "only an approved, active product is published (this one is " + product.status + ")" };
    }
    const cfg = await getConfig();
    const found = problemsWith(product, cfg);
    if (found.length) {
      const error = "not published: " + found.join("; ");
      await stampPublish(product, error);
      await log({ level: "error", kind: "publish", product: product._id, msg: str(product.name) + " " + error });
      await tell("Code shop: " + str(product.name) + " " + error);
      return { results: [], error };
    }

    const enabled = cfg.markets || {};
    const results = [];
    // One cover per call, shared by the markets, deleted in `finally`.
    let coverJob = null;
    const coverPath = () => coverJob || (coverJob = Promise.resolve().then(() => cover().build(product)));
    try {
      const seen = new Set();
      for (const raw of Array.isArray(product.markets) ? product.markets : []) {
        const market = str(raw);
        if (seen.has(market)) continue;
        seen.add(market);
        let r;
        if (!ALLOWED_MARKETS.includes(market)) {
          r = { market, ok: false, skipped: "not a code shop market" };
        } else if (enabled[market] !== true) {
          r = { market, ok: false, skipped: "switched off in the code shop settings" };
        } else {
          try {
            r = await publishOne(product, cfg, market, coverPath);
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
    return { results };
  }

  async function publishOne(product, cfg, market, coverPath) {
    const live = await MarketplaceListing().exists({ accountOffer: product.offer, marketplace: market, status: "active" });
    if (live) return { market, ok: false, skipped: "already live" };
    const shelf = Number(await stock().shelfFor(product.offer)) || 0;
    if (shelf < 1) return { market, ok: false, skipped: "no stock yet" };
    const ctx = { shelf, price: priceOf(product), coverPath };
    if (market === "eldorado") return publishEldorado(product, ctx);
    return publishGgsel(product, cfg, ctx);
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

  async function countActive(product, market) {
    if (!product.offer) return 0;
    return MarketplaceListing().countDocuments({ accountOffer: product.offer, marketplace: market, status: "active" });
  }

  const GGSEL_BY_HAND = "GGSel listings are not taken down here: delist them from the Listings page, which empties the vault";

  async function pause(id, { actor = "" } = {}) {
    const product = await loadProduct(id);
    if (!product) return { ok: false, error: "product not found" };
    if (product.status !== "active" && product.status !== "paused") {
      return { ok: false, error: "a " + product.status + " product cannot be paused" };
    }
    const down = await takeDownEldorado(product);
    await CodeProduct().updateOne({ _id: product._id, status: { $in: ["active", "paused"] } }, { $set: { status: "paused" } });
    const ggselLive = await countActive(product, "ggsel");
    const msg =
      "Paused " +
      str(product.name) +
      ": " +
      down.delisted +
      " Eldorado listing(s) taken down" +
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

  async function resume(id, { actor = "" } = {}) {
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
    const published = await publishProduct(product._id, { actor });
    return { ok: true, product: await loadProduct(product._id), publish: published };
  }

  async function retire(id, { actor = "" } = {}) {
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
      paused = await pause(product._id, { actor });
      if (!paused.ok) {
        const why = (paused.errors || []).join("; ") || paused.error || "the Eldorado listings could not be taken down";
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

  return { problems, approve, publishProduct, pause, resume, retire };
}

module.exports = { createPublisher, ALLOWED_MARKETS, ELDORADO_MIN_USD, OFFER_LIMIT_MSG, HELD_IN_VAULT, priceOf };
