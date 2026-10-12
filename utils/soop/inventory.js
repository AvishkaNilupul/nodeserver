// SOOP drops inventory (docs/SOOP-FARM-CONTRACT.md §9, §15, §18).
//
// Reads what each account holds and keeps a local copy, so the panel can answer
// "what do we have, and what expires first" without asking SOOP on every page
// load. A sync only reads. claim() is the one call that changes anything on
// SOOP; who decides to make it is the caller's business (a click in the panel,
// or ./autoClaim.js for code rewards).
//
// Reward codes are the product. A code leaves this file in exactly one place,
// revealCode(); everywhere else it exists only as `codeEnc` (utils/secretBox),
// and no read path selects that field. Never log a code. A row that holds a
// code is never deleted by a sync: the code is ours whatever SOOP still lists.

const mongoose = require("mongoose");
const { plainMessage } = require("./errors");
const { encrypt, decrypt } = require("../secretBox");
const { normalizeInventoryItem } = require("./normalize");

const DIVISIONS = ["available", "acquired", "expired"];
const CODE_FIELDS = ["itemCode", "code", "pinNo", "couponNo"];
const SOON_MS = 72 * 3600 * 1000;
const VIEW_FIELDS =
  "loginId key division name nameRaw kind gameNo gameName image expiresAt sentAt receivedAt needsLink linkPath used hasCode syncedAt claimedAt claim auto goneAt";
// What SOOP puts in `itemCode` when it has run out of codes for a reward.
const PENDING_CODE = "2차지급예정";
const CLAIM_MESSAGES = {
  code: "Claimed — the code is ready.",
  link: "Claimed — the reward is a link.",
  ingame: "Claimed — the reward was sent to the linked game account.",
  pending: "SOOP has run out of codes for this reward and says it will deliver it later. Check again in a few days.",
  renewed: "SOOP reissued this reward: a new one was added to the inventory. Sync, then claim the new one.",
};
const stripHtml = (html) =>
  String(html || "")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim()
    .slice(0, 2000);
const CSV_HEADER = "loginId,game,item,kind,division,expiresAt,hasCode";

// One id at a time with a pause in between, so a "sync everything" click cannot
// turn into a burst from one IP. Shared with the health sweep (health.js).
function createBatchRunner({ run, paceMs = 0, now = Date.now, maxErrors = 50, onIdle }) {
  const state = { running: false, done: 0, total: 0, lastAt: null, errors: [] };
  let queue = [];
  let busy = false;
  let timer = null;
  let wake = null;

  const pause = (ms) =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      if (timer.unref) timer.unref();
    });

  async function loop() {
    while (queue.length) {
      const id = queue.shift();
      busy = true;
      try {
        await run(id);
      } catch (err) {
        state.errors.push({
          id,
          code: (err && err.code) || "ERROR",
          error: String(plainMessage(err)).slice(0, 200),
          at: new Date(now()),
        });
        if (state.errors.length > maxErrors) state.errors.shift();
      }
      busy = false;
      state.done += 1;
      state.lastAt = new Date(now());
      if (queue.length) await pause(paceMs);
    }
    state.running = false;
    try {
      if (onIdle) onIdle(status());
    } catch {
      /* a reporting hook must not break the runner */
    }
  }

  // A call while a batch is running joins it instead of starting a second one.
  function enqueue(ids) {
    if (!state.running) Object.assign(state, { done: 0, total: 0, errors: [] });
    const seen = new Set(queue);
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw === undefined || raw === null ? "" : raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
      state.total += 1;
    }
    if (!state.running && queue.length) {
      state.running = true;
      loop();
    }
    return { total: state.total };
  }

  // Drops what has not started; the account being worked on finishes normally.
  function cancel() {
    queue = [];
    state.total = state.done + (busy ? 1 : 0);
    if (timer) clearTimeout(timer);
    timer = null;
    if (wake) wake();
  }

  function status() {
    return { ...state, errors: state.errors.slice() };
  }
  return { enqueue, cancel, status };
}

function view(doc) {
  return {
    id: String(doc._id),
    loginId: doc.loginId,
    key: doc.key,
    division: doc.division,
    name: doc.name || "",
    nameRaw: doc.nameRaw || "",
    kind: doc.kind || "other",
    gameNo: doc.gameNo || null,
    gameName: doc.gameName || "",
    image: doc.image || null,
    expiresAt: doc.expiresAt || null,
    sentAt: doc.sentAt || null,
    receivedAt: doc.receivedAt || null,
    needsLink: !!doc.needsLink,
    linkPath: doc.linkPath || null,
    used: !!doc.used,
    hasCode: !!doc.hasCode,
    syncedAt: doc.syncedAt || null,
    claimedAt: doc.claimedAt || null,
    claim: doc.claim || null,
    // Why the automatic claim has not finished this one, when it has not.
    auto: doc.auto ? { tries: Number(doc.auto.tries) || 0, at: doc.auto.at || null, error: String(doc.auto.error || "") } : null,
    goneAt: doc.goneAt || null,
  };
}

// Item names come from SOOP: quote them, and stop a spreadsheet from running
// one that starts like a formula.
function csvCell(value) {
  let s = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function createInventoryService({ models, getClient, activity, paceMs = 2500, now = Date.now } = {}) {
  if (typeof getClient !== "function") throw new TypeError("inventory service needs getClient");
  const Item = () =>
    (models && models.SoopInventoryItem) || require("../../models/SoopInventoryItem");
  const inFlight = new Map();

  function note(entry) {
    try {
      if (activity) activity.add({ kind: "inventory", ...entry });
    } catch {
      /* the log is never a reason to fail a sync */
    }
  }

  async function doSync(id, { quiet = false } = {}) {
    const startedAt = new Date(now());
    const client = await getClient(id);
    const counts = await client.inventoryCounts();
    // All three lists are read BEFORE anything is written: if one read fails the
    // sync fails as a whole, and nothing is deleted on a partial picture.
    const byKey = new Map();
    for (const division of DIVISIONS) {
      for (const raw of (await client.inventory(division)) || []) {
        const item = normalizeInventoryItem(raw, division);
        if (item && item.key) byKey.set(String(item.key), item);
      }
    }
    const at = new Date(now());
    // A reward claimed while these lists were being read is still in the list
    // it was read from. The claim's own write is the newer truth, so its row
    // is left alone here (seen on 2026-10-12: forty claims seven seconds
    // apart, four rows back to "unclaimed" behind them).
    const known = await Item()
      .find({ loginId: id, $or: [{ claimedAt: { $gte: startedAt } }, { hasCode: true }] })
      .select("key claimedAt hasCode")
      .lean();
    const claimedSince = new Set(known.filter((r) => r.claimedAt && r.claimedAt >= startedAt).map((r) => String(r.key)));
    // A code we hold came from the claim call. Whatever a list row carries in
    // a code field later (SOOP's lists carry none today; a masked one would do
    // it) must never replace it.
    const holdsCode = new Set(known.filter((r) => r.hasCode).map((r) => String(r.key)));
    const ops = [];
    for (const [key, item] of byKey) {
      if (claimedSince.has(key)) continue;
      const { code: listed, key: _key, raw, ...fields } = item;
      const code = holdsCode.has(key) ? null : listed;
      const safeRaw = { ...(raw || {}) };
      for (const f of CODE_FIELDS) delete safeRaw[f];
      ops.push({
        updateOne: {
          filter: { loginId: id, key },
          update: {
            // SOOP's list never carries the code (it comes from the claim
            // call), so a sync must not wipe one that is already stored.
            $set: {
              ...fields,
              raw: safeRaw,
              ...(code ? { hasCode: true, codeEnc: encrypt(code) } : {}),
              syncedAt: at,
              goneAt: null,
            },
          },
          upsert: true,
        },
      });
    }
    let added = 0;
    if (ops.length) {
      const res = await Item().bulkWrite(ops, { ordered: false });
      added = Number((res && res.upsertedCount) || 0);
    }
    // SOOP's own counter says the account holds items but every list came back
    // empty: that is a bad read, not an empty inventory. Keep the stored rows.
    const claimed = DIVISIONS.reduce((n, d) => n + (Number(counts && counts[d]) || 0), 0);
    if (!byKey.size && claimed > 0) {
      note({ level: "warn", accountId: id, msg: `Inventory lists came back empty although SOOP counts ${claimed} item(s); kept the stored rows` });
    } else {
      // What SOOP no longer lists is gone — except a row holding a code. That
      // code was handed to us and may still be unused, so the row stays, with
      // the day it dropped off SOOP's lists.
      const listed = [...byKey.keys()];
      await Item().deleteMany({ loginId: id, key: { $nin: listed }, hasCode: { $ne: true } });
      await Item().updateMany({ loginId: id, key: { $nin: listed }, hasCode: true, goneAt: null }, { $set: { goneAt: at } });
    }
    const items = await forAccount(id);
    // A read made on a schedule says so only when it found something.
    if (!quiet || added) note({ accountId: id, msg: `Inventory synced: ${byKey.size} item(s), ${added} new` });
    return { id, counts, items, added, at };
  }

  // Two syncs of one account at once would race on the unique (loginId, key)
  // index, so a second caller gets the first caller's promise.
  // `quiet`: no activity entry for a read that found nothing new, or that failed.
  function syncAccount(rawId, { quiet = false } = {}) {
    const id = String(rawId || "");
    if (!id) return Promise.reject(new Error("no account given"));
    if (inFlight.has(id)) return inFlight.get(id);
    const p = doSync(id, { quiet })
      .catch((err) => {
        // A quiet caller says what went wrong itself, once, in its own words.
        if (!quiet) note({ level: "warn", accountId: id, msg: `Inventory sync failed: ${plainMessage(err)}`, data: { code: err.code || null } });
        throw err;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  // Resolves once no sync of this account is under way. Never rejects.
  function settled(rawId) {
    const p = inFlight.get(String(rawId || ""));
    return p ? p.then(() => {}, () => {}) : Promise.resolve();
  }

  const batch = createBatchRunner({ run: syncAccount, paceMs, now });

  async function forAccount(id) {
    const rows = await Item().find({ loginId: String(id || "") }).select(VIEW_FIELDS).lean();
    const far = Number.MAX_SAFE_INTEGER;
    const time = (d) => (d ? new Date(d).getTime() : far);
    return rows.map(view).sort(
      (a, b) =>
        DIVISIONS.indexOf(a.division) - DIVISIONS.indexOf(b.division) ||
        time(a.expiresAt) - time(b.expiresAt) ||
        a.name.localeCompare(b.name),
    );
  }

  async function summary() {
    const rows = await Item()
      .find({})
      .select("loginId division name kind gameNo gameName image expiresAt syncedAt")
      .lean();
    const t = now();
    const totals = { available: 0, acquired: 0, expired: 0, expiringSoon: 0 };
    const games = new Map();
    let lastSyncAt = null;
    for (const r of rows) {
      if (!DIVISIONS.includes(r.division)) continue;
      totals[r.division] += 1;
      if (r.syncedAt && (!lastSyncAt || r.syncedAt > lastSyncAt)) lastSyncAt = r.syncedAt;
      const exp = r.expiresAt ? new Date(r.expiresAt).getTime() : null;
      const live = r.division === "available" && exp !== null && exp >= t;
      if (live && exp <= t + SOON_MS) totals.expiringSoon += 1;

      const gameNo = r.gameNo || null;
      if (!games.has(gameNo)) games.set(gameNo, { gameNo, gameName: r.gameName || "Other", items: new Map() });
      const game = games.get(gameNo);
      const itemKey = `${r.name}|${r.kind}`;
      if (!game.items.has(itemKey)) {
        game.items.set(itemKey, {
          name: r.name || "", kind: r.kind || "other", image: null,
          available: 0, acquired: 0, expired: 0, soonestExpiry: null, accountIds: new Set(),
        });
      }
      const item = game.items.get(itemKey);
      item[r.division] += 1;
      if (!item.image && r.image) item.image = r.image;
      if (live && (!item.soonestExpiry || exp < item.soonestExpiry.getTime())) item.soonestExpiry = new Date(exp);
      item.accountIds.add(r.loginId);
    }
    return {
      totals,
      lastSyncAt,
      games: [...games.values()]
        .map((g) => ({
          gameNo: g.gameNo,
          gameName: g.gameName,
          items: [...g.items.values()]
            .map((i) => ({ ...i, accountIds: [...i.accountIds].sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.gameName.localeCompare(b.gameName)),
    };
  }

  // Reads SOOP's reply to the claim / check-info call into what we keep.
  function readUseInfo(row, data) {
    const value = String((data && data.itemCode) || "").trim();
    let kind;
    if (data && data.renewFlag === "Y") kind = "renewed";
    else if (value === PENDING_CODE) kind = "pending";
    else if (row.kind === "ingame") kind = "ingame";
    else if (String((data && data.itemType) || "") === "2") kind = "link";
    else kind = value ? "code" : "ingame";
    const secret = kind === "code" || kind === "link" ? value : "";
    return {
      secret,
      claim: {
        kind,
        message: CLAIM_MESSAGES[kind],
        description: stripHtml(data && data.itemDescription),
        gameTitle: String((data && data.gameTitle) || "").slice(0, 120),
        dropsName: String((data && data.dropsName) || "").slice(0, 200),
      },
    };
  }

  async function fetchUseInfo(row) {
    const idx = row.raw && row.raw.itemCodeIdx;
    if (!idx) throw Object.assign(new Error("This reward has no SOOP item id, so it cannot be read from here"), { status: 400 });
    const client = await getClient(row.loginId);
    if (typeof client.useInfo !== "function") throw new Error("this client cannot claim rewards");
    const out = readUseInfo(row, await client.useInfo(idx));
    const set = { claim: out.claim, used: true };
    if (out.secret) Object.assign(set, { hasCode: true, codeEnc: encrypt(out.secret) });
    return { out, set };
  }

  // Claims ONE unclaimed reward on SOOP with the account's stored session. This
  // cannot be undone, so every refusal below is checked before SOOP is called.
  // `sync: false` leaves the follow-up sync to a caller that claims several
  // rewards of one account in a row and syncs once at the end.
  // -> { ok: true, result: { kind, message, description, code } } | { ok: false, error }
  async function claim(itemId, { sync = true } = {}) {
    if (!itemId || !mongoose.isValidObjectId(itemId)) return { ok: false, error: "Unknown inventory item" };
    const row = await Item().findById(itemId).lean();
    if (!row) return { ok: false, error: "Unknown inventory item" };
    if (row.division === "acquired") return { ok: false, error: "This reward is already claimed — use Show code" };
    if (row.division !== "available") return { ok: false, error: "This reward has expired and can no longer be claimed" };
    if (row.expiresAt && new Date(row.expiresAt).getTime() < now()) {
      return { ok: false, error: "This reward has expired and can no longer be claimed" };
    }
    if (row.needsLink) return { ok: false, error: "Link the game account on SOOP first — this reward is sent in-game" };
    if (!(row.raw && row.raw.itemCodeIdx)) return { ok: false, error: "This reward has no SOOP item id — sync the account and try again" };

    const { out, set } = await fetchUseInfo(row);
    const at = new Date(now());
    // A reissued reward was not consumed: leave it for the next sync to sort out.
    if (out.claim.kind !== "renewed") Object.assign(set, { division: "acquired", claimedAt: at, receivedAt: at });
    await Item().updateOne({ _id: row._id }, { $set: set });
    note({ kind: "claim", accountId: row.loginId, msg: `Claimed "${row.name}" on ${row.loginId}: ${out.claim.message}` });
    if (sync) syncAccount(row.loginId).catch(() => {});
    return { ok: true, result: { ...out.claim, name: row.name, loginId: row.loginId, code: out.secret || null } };
  }

  // The only place a code is decrypted. The caller decides who may ask.
  // A reward claimed by hand on SOOP has no stored code yet: it is read back
  // once with the check-info call — which is only ever sent for a reward that
  // is ALREADY claimed, because the same call on an unclaimed one claims it.
  async function reveal(itemId) {
    if (!itemId || !mongoose.isValidObjectId(itemId)) return null;
    const row = await Item().findById(itemId).lean();
    if (!row) return null;
    if (row.codeEnc) return { code: decrypt(row.codeEnc) || null, claim: row.claim || null };
    if (row.division !== "acquired" || !(row.raw && row.raw.itemCodeIdx)) return null;
    const { out, set } = await fetchUseInfo(row);
    await Item().updateOne({ _id: row._id }, { $set: set });
    return { code: out.secret || null, claim: out.claim };
  }

  async function revealCode(itemId) {
    const r = await reveal(itemId);
    return (r && r.code) || null;
  }

  async function csv() {
    const rows = await Item()
      .find({})
      .select("loginId gameName name kind division expiresAt hasCode")
      .lean();
    const order = (r) => `${r.loginId}\u0000${r.gameName || ""}\u0000${r.name || ""}`;
    rows.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    const lines = [CSV_HEADER];
    for (const r of rows) {
      lines.push(
        [
          r.loginId, r.gameName, r.name, r.kind, r.division,
          r.expiresAt ? new Date(r.expiresAt).toISOString() : "",
          r.hasCode ? "yes" : "no",
        ].map(csvCell).join(","),
      );
    }
    return lines.join("\n") + "\n";
  }

  return {
    syncAccount,
    settled,
    syncMany: (ids) => batch.enqueue(ids),
    status: () => batch.status(),
    summary,
    forAccount,
    claim,
    reveal,
    revealCode,
    csv,
  };
}

module.exports = { createInventoryService, createBatchRunner };
