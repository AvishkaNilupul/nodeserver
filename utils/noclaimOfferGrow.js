// No-claim Eldorado offer GROW — docs/NOCLAIM-OFFER-ROTATION-CONTRACT.md §Grow.
//
// WHY THIS EXISTS
//
// A no-claim Eldorado offer sells ONE fixed no-claim DropSet. The rotation
// (utils/noclaimOfferRotation) only steps in once that set has expired off
// every account and the stock sync has paused the offer. A set that is still
// in stock is never looked at again — so when the accounts go on to farm MORE,
// the offer keeps advertising the small bundle it was made with.
//
// Measured 2026-10-06: all four Overwatch offers still said "OWCS Stage 3 Asia
// Kickoff (6 Items)" while 271 of 367 accounts held those 6 plus 5× "100 Comp
// Points". Every sale shipped the extra five drops unadvertised.
//
// Owner rule (2026-10-06): when the accounts hold more than an offer
// advertises, the offer is updated to the bigger bundle — same offer, same
// price, still on sale.
//
// SAFETY
//
//   - The new bundle always CONTAINS the old one (every old item, at least as
//     many copies). Nothing is ever removed here; a bundle that expired is the
//     rotation's job.
//   - The row moves to the bigger set FIRST and the offer text follows. In
//     between, a buyer of the old text is handed the bigger bundle — more than
//     they paid for, never less. The other order could sell 11 items and
//     deliver 6.
//   - The offer is never paused. Price is never sent. Quantity is re-counted
//     for the new set straight away.
//   - A text edit that fails leaves a marker on the row and is retried on the
//     next pass; until then the offer under-advertises, as it did before.
//   - Only rows that are on sale: an offer the stock sync paused belongs to the
//     rotation, and bulk-pack rows are left to the bulk system.
//   - A set never grows into a bundle another live offer of the game already
//     sells — two deliberately different offers stay different.
//   - Kill switch: autoFarm.noclaimGrowOffers === false.

const settings = require("./settings");
const rot = require("./noclaimOfferRotation");

const {
  MIN_ACCOUNTS,
  RECENT_CAMPAIGN_MS,
  sameGame,
  itemsSignature,
  bundleLabel,
  campaignRecency,
  keyOfItem,
  copiesOf,
  setGame,
  setGameNorms,
} = rot;

// The bigger bundle must still be held by at least this share of ALL the game's
// free accounts (and by MIN_ACCOUNTS) — the rotation's own bar, measured on the
// whole free farm and not on the offer's current stock. Measured on the
// current stock, every pass would move the offer to what the richer half of
// what is left holds, and the stock would halve each time.
const GROW_SHARE = rot.MIN_SHARE;
// A set that just grew is left alone for a while, so a wave landing account by
// account is one edit, not one every 15 minutes.
const GROW_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Each grown row costs ~3 Eldorado calls; the stock tick runs every 15 min.
const MAX_SETS_PER_PASS = 2;
const MAX_ROWS_PER_PASS = 6;
// Left in the row's note between the row moving and its text landing.
const TEXT_PENDING = "listing text still to update";

const state = {
  running: false,
  lastRun: null,
  lastSummary: "",
};

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

function str(v) {
  return v == null ? "" : String(v);
}

function timeOf(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

function totalCopies(items) {
  let n = 0;
  for (const it of items || []) n += copiesOf(it);
  return n;
}

// "" when the row is an on-sale no-claim Eldorado offer this may grow.
function rowSkipReason(row) {
  if (!row) return "no row";
  if (row.marketplace !== "eldorado") return "not an Eldorado row";
  if (row.noclaimStock !== true) return "not a no-claim row";
  if (row.status !== "active") return "row is " + (row.status || "?");
  if (row.autoPaused === true) return "paused by the stock sync";
  if (row.bulkOfferId) return "bulk pack row";
  if (!row.set) return "no set";
  return "";
}

function textPending(row) {
  return str(row && row.note).includes(TEXT_PENDING);
}

// "5× 100 Comp Points + 9× Esports Pack (was 6×)"
function addedLabel(added) {
  return (added || [])
    .map((a) => (a.to > 1 ? a.to + "× " : "") + a.name + (a.from > 0 ? " (was " + a.from + "×)" : ""))
    .join(" + ");
}

// The bigger bundle the accounts behind `current` hold now.
//   holdings  — NoclaimHolding docs (noclaimHoldings.snapshotBase().holdings)
//   isFree(h) / isFresh(h) — the snapshot's own rules, bound by the caller
//   campaigns — campaignRecency() output
//   current   — the set's items
// Returns { items, added, covering, current, minCover, pool, newestOnly } or
// { items:null, reason }. `items` always contains `current`.
//   pool     — free + fresh accounts holding any drop of the game
//   current  — those of them that hold the whole current bundle
//   covering — those of them that hold the bigger one
function pickGrowBundle({ holdings, isFree, isFresh, game, campaigns, current, now = Date.now() } = {}) {
  const required = new Map();
  const order = [];
  const curMeta = new Map();
  for (const it of current || []) {
    const k = keyOfItem(it);
    if (!k) continue;
    if (!required.has(k)) {
      order.push(k);
      curMeta.set(k, it);
    }
    required.set(k, (required.get(k) || 0) + copiesOf(it));
  }
  if (!required.size) return { items: null, pool: 0, reason: "the set has no items" };

  let pool = 0;
  // The offer's own stock: free + fresh accounts that hold the whole current
  // bundle. Only these can say what "more" is.
  const holders = [];
  const meta = new Map();
  for (const h of holdings || []) {
    if (!h || h.inConfig === false) continue;
    if (!isFree(h) || !isFresh(h)) continue;
    const counts = new Map();
    const seen = [];
    for (const it of h.items || []) {
      if (!it || !sameGame(it.game, game)) continue;
      const k = keyOfItem(it);
      if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + copiesOf(it));
      seen.push([k, it]);
    }
    if (!counts.size) continue;
    pool++;
    let covers = true;
    for (const [k, q] of required) {
      if ((counts.get(k) || 0) < q) {
        covers = false;
        break;
      }
    }
    if (!covers) continue;
    holders.push(counts);
    for (const [k, it] of seen) {
      let m = meta.get(k);
      if (!m) {
        m = { itemKey: k, name: str(it.name), game: str(it.game), image: str(it.image), campaigns: new Set() };
        meta.set(k, m);
      }
      if (!m.name && it.name) m.name = str(it.name);
      if (!m.image && it.image) m.image = str(it.image);
      const c = str(it.campaign).trim().toLowerCase();
      if (c) m.campaigns.add(c);
    }
  }
  if (pool < MIN_ACCOUNTS) {
    return {
      items: null,
      pool,
      reason: "only " + pool + " free account(s) hold " + (game || "this game") + " drops",
    };
  }
  const minCover = Math.max(MIN_ACCOUNTS, Math.ceil(pool * GROW_SHARE));
  if (holders.length < minCover) {
    return {
      items: null,
      pool,
      current: holders.length,
      reason:
        "the current bundle is held by " + holders.length + " of the " + pool +
        " free accounts — already under the " + minCover + " a bigger one needs",
    };
  }

  // Same "newest" rule as the rotation, so the two never disagree about what a
  // bundle should hold: items of a live or just-ended campaign when there are
  // any, otherwise everything the accounts carry.
  const rec = campaigns instanceof Map ? campaigns : new Map();
  let cands = [...meta.values()].map((m) => {
    let active = false;
    let endAt = 0;
    for (const c of m.campaigns) {
      const r = rec.get(c);
      if (!r) continue;
      if (r.active) active = true;
      if (r.endAt > endAt) endAt = r.endAt;
    }
    const held = holders.filter((counts) => counts.has(m.itemKey)).length;
    return { m, active, endAt, holders: held };
  });
  const newest = cands.filter((c) => c.active || (c.endAt && c.endAt >= now - RECENT_CAMPAIGN_MS));
  const newestOnly = newest.length > 0;
  if (newestOnly) cands = newest;
  cands.sort(
    (a, b) =>
      (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
      b.holders - a.holders ||
      b.endAt - a.endAt ||
      a.m.itemKey.localeCompare(b.m.itemKey),
  );

  let cover = holders;
  const grown = new Map(required);
  const added = [];
  for (const c of cands) {
    const k = c.m.itemKey;
    const held = cover
      .map((counts) => counts.get(k) || 0)
      .filter((q) => q > 0)
      .sort((x, y) => y - x);
    if (held.length < minCover) continue;
    // The minCover-th largest count is the most copies at least minCover of
    // the still-covering accounts hold.
    const q = held[minCover - 1];
    const cur = required.get(k) || 0;
    if (q <= cur) continue;
    cover = cover.filter((counts) => (counts.get(k) || 0) >= q);
    grown.set(k, q);
    added.push({ itemKey: k, name: c.m.name || k.split("|")[0], from: cur, to: q });
  }
  if (!added.length) {
    return { items: null, pool, current: holders.length, reason: "the accounts hold nothing more than the offer sells" };
  }

  const items = [];
  for (const k of order) {
    const it = curMeta.get(k);
    const m = meta.get(k) || {};
    items.push({
      itemKey: k,
      name: str(it.name) || m.name || k.split("|")[0],
      game: str(it.game) || m.game || game,
      image: str(it.image) || m.image || "",
      qty: grown.get(k),
    });
  }
  for (const a of added) {
    if (required.has(a.itemKey)) continue;
    const m = meta.get(a.itemKey);
    items.push({ itemKey: a.itemKey, name: a.name, game: m.game || game, image: m.image, qty: a.to });
  }
  return { items, added, covering: cover.length, current: holders.length, minCover, pool, newestOnly };
}

// ---------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------

function baseNote(fromSet, toSet, now) {
  return (
    "no-claim auto-delivery: an account is claimed when an order lands — grown " +
    new Date(now).toISOString().slice(0, 16).replace("T", " ") + "Z from set " +
    String(fromSet) + " to " + String(toSet)
  );
}

// Rewrite one offer's title, description and cover to its row's set. The row
// is already on that set, so a failure here only leaves the old (smaller) text
// up — the pending marker stays and the next pass comes back.
async function applyText(d, row, live, ctx) {
  const ext = str(row.externalId);
  const priceBefore = Number(live && live.pricePerUnit && live.pricePerUnit.amount);
  let updated;
  try {
    updated = await d.mp.eldoradoUpdateOffer(ext, {
      title: ctx.title,
      description: ctx.description,
      mainOfferImage: ctx.image,
      offerImages: [],
    });
  } catch (e) {
    return { error: "offer edit: " + e.message };
  }
  if (!updated || str(updated.offerTitle) !== ctx.title.slice(0, 160)) {
    return { error: "the new title did not take on Eldorado — retried next pass" };
  }
  if (
    Number.isFinite(priceBefore) &&
    Number(updated.pricePerUnit && updated.pricePerUnit.amount) !== priceBefore
  ) {
    return { error: "the price moved during the edit — check the offer" };
  }
  // The text landed: record it before anything else, so nothing below can
  // make the next pass edit the offer again.
  await d.MarketplaceListing.updateOne(
    { _id: row._id, set: ctx.set._id },
    {
      $set: {
        title: ctx.title,
        description: ctx.description,
        note: ctx.note,
        rebundledAt: new Date(ctx.now),
      },
    },
  );
  // An edit is not meant to take an offer off sale. If it did, put back the
  // state it was read in a moment ago; a failure is reported, never retried.
  if (live.offerState === "Active" && updated.offerState && updated.offerState !== "Active") {
    try {
      await d.mp.eldoradoRelist(ext);
    } catch (e) {
      return { done: true, warn: "the edit left the offer " + updated.offerState + " and resuming it failed: " + e.message };
    }
  }
  return { done: true };
}

// Title, description and uploaded cover for a set. Throws; the caller decides
// what a failure means.
async function listingCopy(d, set) {
  const text = await d.text(set);
  if (!str(text && text.title).trim()) throw new Error("no title for the bundle");
  let cover = "";
  try {
    cover = await d.buildCover(set);
    if (!cover) throw new Error("cover image not built");
    const image = await d.mp.eldoradoUploadImage(cover);
    return { title: text.title, description: text.description || "", image };
  } finally {
    if (cover) d.unlink(cover);
  }
}

// Live offers of a group, read one by one. Map<externalId, offer|null>.
async function readOffers(d, group, out, label) {
  const live = new Map();
  for (const r of group) {
    const ext = str(r.externalId);
    try {
      live.set(ext, (await d.mp.eldoradoOffer(ext)) || null);
    } catch (e) {
      live.set(ext, null);
      out.errors.push({ set: String(r.set), label, externalId: ext, error: "offer read: " + e.message });
    }
  }
  return live;
}

// Advertise what the row's (new) set really has. A failure is the next stock
// sync's to fix, 15 minutes away.
async function syncQuantity(d, rowId, ext, live) {
  try {
    const moved = await d.MarketplaceListing.findById(rowId).lean();
    const stock = await d.ncs.stockForListing(moved);
    if (stock > 0 && live && live.offerState === "Active") {
      if (Number(live.quantity) !== stock) await d.mp.eldoradoSetQuantity(ext, stock);
      await d.MarketplaceListing.updateOne({ _id: rowId }, { $set: { qtyTarget: stock } });
    }
    return stock;
  } catch {
    return null;
  }
}

// `dryRun` makes no Eldorado call and no write: it returns `plan`, what a real
// pass would do, for every set (no per-pass limit).
async function growPass(opts = {}) {
  if (state.running) return { skipped: "already running" };
  const d = opts.deps || rot.realDeps();
  const now = opts.now || Date.now();
  const dryRun = opts.dryRun === true;
  const af = (d.settings.getAutoFarm && d.settings.getAutoFarm()) || {};
  if (af.noclaimGrowOffers === false) {
    return { skipped: "switched off (autoFarm.noclaimGrowOffers)" };
  }
  state.running = true;
  const out = { at: new Date(now), dryRun, grown: [], repaired: [], plan: [], skipped: [], errors: [], log: [] };
  try {
    const rows = await d.MarketplaceListing.find({
      marketplace: "eldorado",
      noclaimStock: true,
      status: "active",
    }).lean();
    const bySet = new Map();
    for (const r of rows || []) {
      if (rowSkipReason(r)) continue;
      const k = String(r.set);
      (bySet.get(k) || bySet.set(k, []).get(k)).push(r);
    }

    // Biggest bundle first: when two sets of a game could grow into the same
    // thing, the bigger one takes it and the smaller stays what it is.
    const groups = [];
    for (const [setId, group] of bySet) {
      const set = await d.DropSet.findById(setId).lean();
      groups.push({ setId, group, set });
    }
    groups.sort((a, b) => totalCopies(b.set && b.set.items) - totalCopies(a.set && a.set.items));
    const selling = new Map(); // setId -> { game, sig } of every on-sale set
    for (const g of groups) {
      if (g.set) selling.set(g.setId, { game: setGame(g.set), sig: itemsSignature(g.set.items) });
    }

    let base = null;
    let setsDone = 0;
    let rowsLeft = MAX_ROWS_PER_PASS;
    for (const { setId, group, set } of groups) {
      const label = set ? setGame(set) + " " + bundleLabel(set.items) : setId;
      const skip = (why) => out.skipped.push({ set: setId, label, why });
      if (!set || set.stockSource !== "noclaim") {
        skip("not a no-claim set");
        continue;
      }
      const game = setGame(set);
      const budgetLeft = () => setsDone < MAX_SETS_PER_PASS && (rowsLeft >= group.length || rowsLeft === MAX_ROWS_PER_PASS);

      // 1. A row that moved on an earlier pass but whose text did not land.
      const pending = group.filter(textPending);
      if (pending.length) {
        if (dryRun) {
          out.plan.push({ set: setId, game, repair: pending.map((r) => str(r.externalId)), from: bundleLabel(set.items) });
          continue;
        }
        if (!budgetLeft()) continue;
        const live = await readOffers(d, pending, out, label);
        const readable = pending.filter((r) => live.get(str(r.externalId)));
        if (!readable.length) continue;
        setsDone++;
        let copy;
        try {
          copy = await listingCopy(d, set);
        } catch (e) {
          out.errors.push({ set: setId, label, error: e.message });
          continue;
        }
        for (const row of readable) {
          rowsLeft--;
          const ext = str(row.externalId);
          const ctx = { ...copy, set, now, note: str(row.note).replace(" — " + TEXT_PENDING, "") };
          const r = await applyText(d, row, live.get(ext), ctx);
          if (r.done) out.repaired.push({ externalId: ext, to: copy.title, set: setId });
          if (!r.done || r.warn) {
            out.errors.push({ set: setId, label, externalId: ext, error: r.error || r.warn || "unknown" });
          }
        }
        continue;
      }

      // 2. Does the farm hold more than this set sells?
      if (group.some((r) => now - timeOf(r.rebundledAt) < GROW_COOLDOWN_MS)) continue;
      if (!base) base = await d.nh.snapshotBase();
      const norms = setGameNorms(set);
      const names = new Set();
      for (const h of (base && base.holdings) || []) {
        for (const it of (h && h.items) || []) {
          if (it && it.campaign && sameGame(it.game, game)) names.add(str(it.campaign).trim());
        }
      }
      const campaigns = names.size
        ? campaignRecency(
            await d.TwitchCampaign.find(
              { name: { $in: [...names] } },
              { name: 1, status: 1, active: 1, endAt: 1 },
            ).lean(),
            now,
          )
        : new Map();
      const pick = pickGrowBundle({
        holdings: (base && base.holdings) || [],
        isFree: (h) => d.nh.freeReason(h, base, norms) === "",
        isFresh: (h) => d.nh.isFresh(h, base, now),
        game,
        campaigns,
        current: set.items,
        now,
      });
      // Nothing more to sell is the normal answer — not worth a log line.
      if (!pick.items) continue;

      const sig = itemsSignature(pick.items);
      const twin = [...selling.entries()].find(
        ([id, s]) => id !== setId && s.sig === sig && sameGame(s.game, game),
      );
      if (twin) {
        skip("another offer already sells the bigger bundle (" + addedLabel(pick.added) + " more) — left as it is");
        continue;
      }
      // The stock counter has the last word: never move an offer onto a bundle
      // it would count as (nearly) empty.
      const st = await d.ncs.stockForSet({ stockSource: "noclaim", coverGame: game, items: pick.items });
      if (!st || !(st.free >= MIN_ACCOUNTS)) {
        skip("only " + ((st && st.free) || 0) + " free account(s) hold the bigger bundle (" + addedLabel(pick.added) + " more)");
        continue;
      }

      if (dryRun) {
        let title = "";
        try {
          title = str((await d.text({ stockSource: "noclaim", coverGame: game, items: pick.items })).title);
        } catch (e) {
          title = "(title not built: " + e.message + ")";
        }
        out.plan.push({
          set: setId,
          game,
          offers: group.map((r) => ({ externalId: str(r.externalId), price: r.price, title: r.title })),
          from: bundleLabel(set.items),
          added: addedLabel(pick.added),
          to: title,
          items: totalCopies(pick.items),
          free: st.free,
          current: pick.current,
          pool: pick.pool,
        });
        selling.set(setId, { game, sig });
        continue;
      }
      if (!budgetLeft()) continue;

      const live = await readOffers(d, group, out, label);
      if (!group.some((r) => live.get(str(r.externalId)))) continue; // Eldorado is not answering: touch nothing
      setsDone++;
      let ctx;
      try {
        const target = await rot.targetSet(d, pick.items, {
          game,
          price: set.price,
          fromSet: set,
          now,
          tag: "auto-grown",
          note:
            "Made " + new Date(now).toISOString().slice(0, 10) + " by the no-claim offer grow: the accounts behind set " +
            String(set._id) + " (" + bundleLabel(set.items) + ") now also hold " + addedLabel(pick.added) + ".",
        });
        const copy = await listingCopy(d, target.set);
        ctx = { ...copy, set: target.set, created: target.created, now, note: baseNote(set._id, target.set._id, now) };
      } catch (e) {
        out.errors.push({ set: setId, label, error: e.message });
        continue;
      }

      // Every row of the set moves before any text changes, so a ladder is
      // never split across two bundles and no buyer can be short-changed.
      const moved = [];
      for (const row of group) {
        rowsLeft--;
        const cas = await d.MarketplaceListing.updateOne(
          { _id: row._id, set: row.set, status: "active", autoPaused: { $ne: true } },
          {
            $set: {
              set: ctx.set._id,
              requiredDrops: d.ncs.requiredDropsForSet(ctx.set),
              note: ctx.note + " — " + TEXT_PENDING,
            },
          },
        );
        if (cas && cas.modifiedCount === 1) moved.push(row);
        else {
          out.errors.push({
            set: setId,
            label,
            externalId: str(row.externalId),
            error: "the row changed while growing — left on its old set",
          });
        }
      }
      if (moved.length) selling.set(setId, { game, sig });

      for (const row of moved) {
        const ext = str(row.externalId);
        const offer = live.get(ext);
        if (!offer) {
          out.errors.push({ set: setId, label, externalId: ext, error: "offer unreadable — text retried next pass" });
          continue;
        }
        const r = await applyText(d, row, offer, ctx);
        if (!r.done || r.warn) {
          out.errors.push({ set: setId, label, externalId: ext, error: r.error || r.warn || "unknown" });
        }
        if (!r.done) continue;
        out.grown.push({
          externalId: ext,
          price: row.price,
          from: bundleLabel(set.items),
          added: addedLabel(pick.added),
          to: ctx.title,
          set: String(ctx.set._id),
          newSet: ctx.created,
          covering: pick.covering,
          stock: null,
          rowId: row._id,
        });
      }
      // Quantities last: the share of the shelf depends on every row having moved.
      for (const row of moved) {
        const ext = str(row.externalId);
        const stock = await syncQuantity(d, row._id, ext, live.get(ext));
        const g = out.grown.find((x) => x.externalId === ext);
        if (!g) continue;
        g.stock = stock;
        try {
          d.logEvent({
            category: "noclaim_shop",
            action: "offer_grown",
            actor: "noclaimOfferGrow",
            subject: "eldorado " + ext,
            subjectId: row._id,
            game,
            count: stock == null ? 0 : stock,
            detail:
              "Eldorado offer updated to the bigger bundle the accounts hold now: " + ctx.title +
              " ($" + row.price + ") — added " + addedLabel(pick.added),
            meta: { fromSet: setId, toSet: String(ctx.set._id), newSet: ctx.created },
          });
        } catch {
          /* the audit row must never undo a grow */
        }
      }
    }

    if (out.grown.length) {
      const text =
        "⬆️ No-claim Eldorado offer updated to the bigger bundle\n\n" +
        out.grown
          .map(
            (x) =>
              x.to + "\n$" + x.price + " · " + (x.stock == null ? "?" : x.stock) + " in stock · offer " +
              x.externalId.slice(0, 8) + "\n(added: " + x.added + ")",
          )
          .join("\n\n");
      try {
        Promise.resolve(d.sendTelegram(text)).catch(() => {});
      } catch {
        /* never fail the pass on a notification */
      }
    }

    // One line per outcome CHANGE, plus every edit: this runs every 15 min.
    for (const x of out.grown) {
      out.log.push("grew eldorado " + x.externalId + " -> " + x.to + " (+" + x.added + ", " + x.stock + " in stock)");
    }
    for (const x of out.repaired) {
      out.log.push("text caught up on eldorado " + x.externalId + " -> " + x.to);
    }
    const summary = [
      ...out.skipped.map((s) => "skip " + s.label + ": " + s.why),
      ...out.errors.map((s) => "error " + s.label + (s.externalId ? " [" + s.externalId.slice(0, 8) + "]" : "") + ": " + s.error),
    ].join(" | ");
    if (!dryRun) {
      if (summary && summary !== state.lastSummary) out.log.push(summary);
      state.lastSummary = summary;
      state.lastRun = out;
    }
    return out;
  } finally {
    state.running = false;
  }
}

function status() {
  return {
    enabled: (settings.getAutoFarm() || {}).noclaimGrowOffers !== false,
    running: state.running,
    lastRun: state.lastRun,
  };
}

module.exports = {
  // constants
  GROW_SHARE,
  GROW_COOLDOWN_MS,
  MAX_SETS_PER_PASS,
  MAX_ROWS_PER_PASS,
  TEXT_PENDING,
  // pure, tested
  rowSkipReason,
  textPending,
  addedLabel,
  pickGrowBundle,
  // pass
  growPass,
  status,
};
