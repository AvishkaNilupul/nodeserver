const fs = require("node:fs/promises");
const path = require("node:path");
const { validId, validateReport, digest, draft } = require("./rivalsAccounts");
const SECTION = Object.freeze({
  key: "marvel-rivals",
  name: "Marvel Rivals accounts",
  gameId: "227",
  tradeEnvironmentId: "9-0",
  offerAttributes: [],
  seoAlias: "marvel-rivals-accounts",
});
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { user: true, status });
const proofRoot = () =>
  process.env.RIVALS_PROOF_DIR || path.join(__dirname, "../.rivals-proof");
function createService(over = {}) {
  const db = () => over.db || require("mongoose").connection.db;
  const sales = () => over.sales || require("./steamSales");
  const eld = () => over.eld || require("./eldoradoAccountOffers");
  const outlook = () => over.outlook || require("./outlookGraphReader");
  const Listing = () => over.Listing || require("../models/SteamListing");
  async function preflight(id) {
    if (!validId(id)) throw fail("Invalid preparation", 400);
    const prep = await db()
      .collection("rivalspreparations")
      .findOne({ _id: id });
    if (!prep?.gameReport)
      throw fail("Import completed game verification first");
    validateReport(prep, {
      ...prep.gameReport,
      id,
      holdId: prep.holdId,
      steamAccountId: String(prep.steamId),
      twitchAccountId: String(prep.twitchId),
      verifiedRewards: prep.gameReport.proofs.map((p) => p.rewardId),
    });
    if (
      prep.listingId ||
      ["publishing", "uncertain", "listed"].includes(prep.publishState)
    )
      throw fail(
        "This preparation already has a listing or an unresolved publish attempt",
      );
    const steam = await db()
      .collection("steamaccounts")
      .findOne({ _id: prep.steamId });
    if (
      !steam ||
      steam.stage !== "problem" ||
      steam.soldAt ||
      !String(steam.notes).includes(id)
    )
      throw fail("Steam account is no longer in its exclusive Rivals hold");
    const count = (name, filter) =>
      db()
        .collection(name)
        .countDocuments(filter, { limit: 1, maxTimeMS: 5000 });
    const other = await Promise.all([
      count("steamlistings", {
        accounts: {
          $elemMatch: {
            steamAccountId: prep.steamId,
            state: { $ne: "removed" },
          },
        },
      }),
      count("steamsales", { "accounts.steamAccountId": prep.steamId }),
      count("steamg2gunits", {
        steamAccountId: prep.steamId,
        state: { $ne: "removed" },
      }),
      count("steamboosts", {
        steamAccountId: prep.steamId,
        state: { $in: ["queued", "boosting", "stopping"] },
      }),
      count("buyermailsessions", {
        steamAccountId: prep.steamId,
        revokedAt: null,
      }),
    ]);
    if (other.some(Boolean))
      throw fail(
        "Account has another sale, listing, mail session or running booster",
      );
    const held = await db()
      .collection("droplogs")
      .countDocuments({
        account: prep.twitchId,
        soldSetId: prep.holdId,
        soldToUsername: "manual",
        soldAt: { $ne: null },
      });
    if (!prep.reservedCount || held !== prep.reservedCount)
      throw fail("Linked Twitch reservation changed");
    const password = sales()._shared.dec(steam.password),
      email = sales()._shared.dec(steam.email).toLowerCase();
    if (!password || !/@/.test(email))
      throw fail("Saved Steam login is incomplete");
    const inbox = await sales()._shared.checkInbox(email, { fresh: true });
    if (!inbox.ok) throw fail("Steam-only inbox verification failed");
    // Same restricted Steam reader the buyer page uses. Never return messages.
    await outlook().readMailFor({
      inboxAddress: email,
      kind: "steam",
      sinceIso: new Date(Date.now() - 86400000).toISOString(),
      top: 1,
    });
    const permission = await eld().epicPermission("227");
    if (permission.error || permission.canSell !== true)
      throw fail("Eldorado account category access is unavailable");
    const root = over.proofDir || proofRoot();
    for (const p of prep.gameReport.proofs)
      if (digest(await fs.readFile(path.join(root, id, p.file))) !== p.sha256)
        throw fail("Costume screenshot changed");
    const cfg = await sales().getConfig();
    if (!sales()._shared.providerUrl())
      throw fail("Site email delivery URL is unavailable");
    const delivery = {
      ok: true,
      kind: "steam",
      sessionDays: cfg.sessionDays,
      checkedAt: new Date(),
    };
    await db()
      .collection("rivalspreparations")
      .updateOne(
        { _id: id, status: "held" },
        { $set: { deliveryAudit: delivery } },
      );
    return {
      prep: { ...prep, deliveryAudit: delivery },
      steam,
      email,
      password,
      cfg,
      root,
    };
  }
  async function checkDelivery(id) {
    const { prep } = await preflight(id);
    return {
      ok: true,
      kind: "steam",
      days: prep.deliveryAudit.sessionDays,
      checkedAt: prep.deliveryAudit.checkedAt,
    };
  }
  async function publish(id, actor = "admin") {
    return sales()._shared.withLock(async () => {
      const existing = await db()
        .collection("rivalspreparations")
        .findOne({ _id: id });
      if (existing?.publishState === "listed" && existing.listingId) {
        const l = await Listing().findById(existing.listingId);
        if (l?.externalId) return sales()._shared.listingView(l.toObject());
      }
      const ctx = await preflight(id),
        { prep, steam, email, password, cfg, root } = ctx;
      const claim = await db()
        .collection("rivalspreparations")
        .updateOne(
          {
            _id: id,
            status: "held",
            listingId: { $exists: false },
            publishState: { $nin: ["publishing", "uncertain", "listed"] },
          },
          {
            $set: { publishState: "publishing", publishStartedAt: new Date() },
          },
        );
      if (claim.modifiedCount !== 1)
        throw fail("Another publish attempt owns this account");
      let listing,
        reserved = false,
        sessionId,
        createStarted = false;
      try {
        const price = Number(prep.draftPriceUsd) || 7.99;
        if (
          !Number.isFinite(price) ||
          price < 0.05 ||
          price > 10000 ||
          Math.abs(price * 100 - Math.round(price * 100)) > 1e-7
        )
          throw fail("Invalid draft price");
        const copy = draft(prep, steam);
        listing = new (Listing())({
          market: "eldorado",
          kind: "rivals",
          preparationId: id,
          appId: 2767030,
          minHours: 0,
          region: steam.signupCountry || "",
          section: SECTION,
          status: "draft",
          title: copy.title,
          description: copy.description,
          priceUsd: price,
          coverSource: `/api/rivals/preparations/${id}/proof/${prep.gameReport.proofs[0].file}`,
          createdBy: String(actor),
          accounts: [],
        });
        await listing.save();
        await db()
          .collection("rivalspreparations")
          .updateOne(
            { _id: id, publishState: "publishing" },
            { $set: { listingId: listing._id } },
          );
        const r = await db()
          .collection("steamaccounts")
          .updateOne(
            {
              _id: prep.steamId,
              stage: "problem",
              soldAt: null,
              notes: steam.notes,
            },
            { $set: { stage: "listed" } },
          );
        if (r.modifiedCount !== 1)
          throw fail("Steam reservation changed during publication");
        reserved = true;
        const minted = await sales()._shared.mintListedSession(
          steam,
          email,
          listing._id,
          actor,
        );
        sessionId = minted.row._id;
        listing.accounts.push({
          steamAccountId: steam._id,
          sessionId,
          login: steam.accountName.toLowerCase(),
          label: steam.accountName,
          state: "listed",
          addedAt: new Date(),
        });
        const entry = sales()._shared.entryFor({
          login: steam.accountName,
          steamPassword: password,
          email,
          mailPassword: minted.password,
          purl: sales()._shared.providerUrl(),
          days: cfg.sessionDays,
        });
        await listing.save();
        const images = [];
        for (const p of prep.gameReport.proofs)
          images.push(await eld().uploadImage(path.join(root, id, p.file)));
        listing.mainOfferImage = images[0];
        await listing.save();
        createStarted = true;
        const created = await eld().createAccountOffer({
          title: copy.title,
          description: copy.description,
          priceUsd: price,
          hasOriginalEmail: false,
          mainOfferImage: images[0],
          offerImages: images.slice(1),
          entries: [entry],
          section: SECTION,
        });
        if (!created.id) throw fail("Eldorado returned no offer ID");
        listing.externalId = created.id;
        listing.url = eld().offerUrl(created.id, SECTION);
        listing.status = "active";
        await listing.save();
        const read = await sales()._shared.readBack(listing);
        const actual = read.entries.find(
          (e) =>
            e.accountLogin?.toLowerCase() === steam.accountName.toLowerCase(),
        );
        if (
          read.entries.length !== 1 ||
          !actual ||
          [
            "accountPassword",
            "emailLogin",
            "emailPassword",
            "emailProviderUrl",
          ].some((k) => actual[k] !== entry[k])
        )
          throw fail("Remote delivery entry did not match");
        listing.lastSyncAt = new Date();
        await listing.save();
        await db()
          .collection("rivalspreparations")
          .updateOne(
            { _id: id },
            {
              $set: {
                publishState: "listed",
                listedAt: new Date(),
                draftPriceUsd: price,
              },
            },
          );
        return sales()._shared.listingView(listing.toObject());
      } catch (e) {
        if (createStarted) {
          if (listing) {
            listing.status = "error";
            if (listing.externalId) {
              try {
                await eld().pauseAccountOffer(listing.externalId);
                listing.status = "paused";
              } catch {
                listing.status = "active";
              }
            }
            listing.lastError =
              "Publication may have reached Eldorado; reconcile this offer before retrying";
            listing.lastErrorAt = new Date();
            await listing.save().catch(() => {});
          }
          await db()
            .collection("rivalspreparations")
            .updateOne({ _id: id }, { $set: { publishState: "uncertain" } });
          throw fail(
            "Publication outcome needs reconciliation. Account and mail delivery remain reserved.",
            502,
          );
        }
        if (sessionId)
          await sales()._shared.revokeSessions([sessionId], "unlisted");
        if (reserved)
          await sales()._shared.release([String(prep.steamId)], { held: true });
        if (listing) {
          listing.status = "removed";
          for (const u of listing.accounts) {
            u.state = "removed";
            u.removedAt = new Date();
            u.removedReason = "publish failed before create";
          }
          await listing.save().catch(() => {});
        }
        await db()
          .collection("rivalspreparations")
          .updateOne(
            { _id: id },
            { $set: { publishState: "failed" }, $unset: { listingId: "" } },
          );
        throw fail(
          "Publication stopped before offer creation; the original Rivals hold is preserved.",
          502,
        );
      }
    });
  }
  return { checkDelivery, publish, preflight };
}
module.exports = createService();
module.exports.createService = createService;
module.exports.SECTION = SECTION;
