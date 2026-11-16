"use strict";

const { Z2uError } = require("./client");
const STORAGE = "/Platform/userStorage/storageEntrance.html?entrance=";
const SELL = "/Sell/publicEntrance.html?type=";

function id(value, name = "id") {
  if ((typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)) ||
      !/^[1-9]\d*$/.test(String(value))) throw new TypeError(`${name} must be a positive decimal identifier`);
  return String(value);
}
function sameId(value, expected) {
  try { return id(value) === expected; } catch { return false; }
}
function enumIs(value, expected) { return value === expected || value === String(expected); }
function text(value, name, { empty = false, max = 100000 } = {}) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0")) throw new TypeError(`Invalid ${name}`);
  return value;
}
function form(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return body;
}
function query(path, fields) {
  return `${path}?${new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== undefined))}`;
}

/** Site form values verified against the signed-in pages on 2026-11-16. */
function buildStorageFields({ gameId, categoryId, name, kind, note = "", deliveryNote = "" }) {
  if (!["account", "code"].includes(kind)) throw new TypeError("kind must be account or code");
  return { add_gid: id(gameId, "gameId"), add_category: id(categoryId, "categoryId"),
    add_parent: "0", add_name: text(name, "name", { max: 300 }), has_psd: kind === "account" ? "1" : "2",
    add_sort: "0", is_repeat: "2", note: text(note, "note", { empty: true }),
    delivery_note: text(deliveryNote, "deliveryNote", { empty: true }) };
}

/**
 * No escaping convention is documented: reject separators/newlines in fields.
 * Site's "Other Info" column becomes remote `remark`; its "Remarks" column
 * becomes remote `note`. Keep a unique import marker in unit.remark (remote note).
 */
function buildImportFields({ storageId, kind, units, totalCostUsd = "0", priority = false }) {
  if (!["account", "code"].includes(kind)) throw new TypeError("kind must be account or code");
  if (!Array.isArray(units) || !units.length || units.length > 1000) throw new TypeError("Import requires 1–1000 units");
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(totalCostUsd))) throw new TypeError("Invalid totalCostUsd");
  const firstFields = new Set();
  const lines = units.map(unit => {
    const first = text(kind === "account" ? unit.account : unit.code, "unit identity");
    if (firstFields.has(first)) throw new TypeError("Duplicate unit identity in import");
    firstFields.add(first);
    const fields = kind === "account" ? [first, text(unit.password, "password"), unit.otherInfo || "", unit.remark || ""] : [first, unit.otherInfo || "", unit.remark || ""];
    for (const value of fields) {
      text(value, "unit field", { empty: true });
      if (/[|\r\n]/.test(value)) throw new TypeError("Unit fields cannot contain pipe separators or newlines");
    }
    return fields.join("|");
  });
  return { add_storage: id(storageId, "storageId"), content: lines.join("\n"), split: "3",
    add_unit: String(totalCostUsd), is_first: priority ? "2" : "1" };
}

function buildDeliveryFields({ offerId, storageId, maxPurchaseQuantity, note = "" }) {
  if (!Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1) throw new TypeError("A verified positive listing maximum is required");
  return { id: id(offerId, "offerId"), is_auto_deliver: "1", outstock: "1", is_agiso: "0",
    storage_id: id(storageId, "storageId"), buy_more: String(maxPurchaseQuantity), note: text(note, "note", { empty: true }) };
}

function verifyDeliverySettings(settings, wanted) {
  if (!settings || typeof settings !== "object") return false;
  return ["id", "storage_id", "buy_more"].every(key => sameId(settings[key], wanted[key])) &&
    ["is_auto_deliver", "outstock", "is_agiso"].every(key => enumIs(settings[key], Number(wanted[key]))) &&
    settings.note === wanted.note;
}

function stockEvidence(product) {
  const zero = value => value === 0 || value === "0";
  const hasBuyer = zero(product.buy_user_id) ? false : product.buy_user_id === undefined || product.buy_user_id === null ? null : true;
  // A recycled row can retain status=1. Absence of an order alone is not enough:
  // all independent deletion/withdrawal/ownership markers must establish unsold.
  const unsoldVerified = enumIs(product.status, 1) && zero(product.delete_time) &&
    product.wd_order === "" && hasBuyer === false && zero(product.buy_order) && product.used_time === null;
  const status = [1, 2, 3, 4, 5].find(value => enumIs(product.status, value)) ?? null;
  return { status, usedTime: product.used_time ?? null,
    saleReference: product.buy_order ? String(product.buy_order) : null,
    deleteTime: product.delete_time ?? null,
    withdrawalReference: product.wd_order === "" ? null : product.wd_order === undefined ? null : String(product.wd_order),
    hasBuyer, unsoldVerified };
}

function extractStoragePage(document) {
  const heading = [...document.querySelectorAll("h1")].map(node => node.textContent).find(value => /Storage List/.test(value)) || "";
  const total = /Totals\s*[:：]\s*(\d+)/i.exec(heading);
  const productIds = [...document.querySelectorAll("#productlist .checkone[data]")].map(node => node.getAttribute("data"));
  const pages = [...document.querySelectorAll("a[href]")].map(node => {
    try {
      const url = new URL(node.getAttribute("href"), "https://www.z2u.com");
      return url.origin === "https://www.z2u.com" && /^\/userStorage\/product(?:\.html)?$/.test(url.pathname) ? Number(url.searchParams.get("page")) : 0;
    } catch { return 0; }
  }).filter(page => Number.isSafeInteger(page) && page > 0);
  return { total: total ? Number(total[1]) : null, productIds, pages };
}

/**
 * Low-level native-vault adapter. Import/create acknowledgments are deliberately
 * unverified. The caller must reserve source stock and durably record upload
 * intent before invoking them, then reconcile IDs against remote storage.
 * No method publishes an offer or sends a manual delivery.
 */
function createVaultProtocol(client) {
  if (!client || typeof client.readPage !== "function" || typeof client.readJson !== "function" || typeof client.mutate !== "function") throw new TypeError("Z2U client required");
  const api = {
    readStoragePage: ({ gameId, categoryId, storageId, status = "", page = 1, keywords = "" } = {}) => {
      if (!["", "1", "2", "3", "4", "5"].includes(String(status))) throw new TypeError("Invalid stock status");
      if (!Number.isSafeInteger(page) || page < 1) throw new TypeError("Invalid page");
      return client.readPage(query("/userStorage/product", { gameid: gameId === undefined ? undefined : id(gameId),
        category_id: categoryId === undefined ? undefined : id(categoryId), storage_id: storageId === undefined ? undefined : id(storageId),
        status, page, keywords: text(keywords, "keywords", { empty: true, max: 300 }) }));
    },
    readCategoriesPage: () => client.readPage("/userStorage/index"),
    readDeliveryLogsPage: ({ startTime = "", endTime = "", keywords = "", page = 1 } = {}) => {
      if (!Number.isSafeInteger(page) || page < 1) throw new TypeError("Invalid page");
      return client.readPage(query("/userStorage/autoDeliverLogs", { start_time: text(startTime, "startTime", { empty: true, max: 30 }),
        end_time: text(endTime, "endTime", { empty: true, max: 30 }), keywords: text(keywords, "keywords", { empty: true, max: 300 }), page }));
    },
    readStorage: storageId => client.readJson(STORAGE + "getOnestorage", { id: id(storageId) }),
    // The return contains credentials: consume privately, never log raw data.
    readProduct: productId => client.readJson(STORAGE + "getOneproduct", { id: id(productId) }),
    readOfferDelivery: offerId => client.readJson(SELL + "getProDetail", { id: id(offerId) }),
    readOfferEditorPage: offerId => client.readPage(query("/sell/manageEdit.html", { id: id(offerId) })),
    readOfferEditor: async (offerId, { parseDocument = html => new DOMParser().parseFromString(html, "text/html") } = {}) => {
      const { extractOfferEditor } = require("./offers");
      const expectedId = id(offerId);
      const editor = extractOfferEditor(parseDocument(await api.readOfferEditorPage(expectedId)));
      if (!editor.valid || editor.offerId !== expectedId) throw new Z2uError("OFFER_UNVERIFIED", "Offer editor identity or form fields were not verified");
      return editor;
    },
    readOfferConstraints: async (offerId, options) => (await api.readOfferEditor(offerId, options)).constraints,
    readOfferGroupPage: ({ gameId, categoryId, page = 1 }) => {
      if (!Number.isSafeInteger(page) || page < 1) throw new TypeError("Invalid page");
      return client.readPage(query("/sell/manageList", { service: id(categoryId), game: id(gameId), page }));
    },
    readOfferGroup: async ({ gameId, categoryId, page = 1,
      parseDocument = html => new DOMParser().parseFromString(html, "text/html") }) => {
      const { extractOfferGroup } = require("./offers");
      const game = id(gameId), service = id(categoryId);
      const group = extractOfferGroup(parseDocument(await api.readOfferGroupPage({ gameId: game, categoryId: service, page })));
      if (!group.valid || group.context.gameId !== game || group.context.categoryId !== service) {
        throw new Z2uError("OFFER_UNVERIFIED", "Offer group identity or row states were not verified");
      }
      return group;
    },
    readOfferState: async ({ offerId, gameId, categoryId, parseDocument, maxPages = 100 }) => {
      const offer = id(offerId), game = id(gameId), service = id(categoryId);
      if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError("Invalid maxPages");
      const queue = [1], visited = new Set(), rows = new Map(), signatures = new Set();
      while (queue.length) {
        if (visited.size >= maxPages) throw new Z2uError("OFFER_UNVERIFIED", "Offer group pagination exceeded the bound");
        const page = queue.shift();
        visited.add(page);
        const group = await api.readOfferGroup({ gameId: game, categoryId: service, page, parseDocument });
        const signature = group.offers.map(row => row.offerId).join(",");
        if (signatures.has(signature) || group.offers.some(row => rows.has(row.offerId))) {
          throw new Z2uError("OFFER_UNVERIFIED", "Offer group pagination repeated rows");
        }
        signatures.add(signature);
        for (const row of group.offers) rows.set(row.offerId, row);
        for (const next of group.pages) if (!visited.has(next) && !queue.includes(next)) queue.push(next);
      }
      if (!rows.has(offer)) throw new Z2uError("OFFER_UNVERIFIED", "Offer was not found in the verified group");
      return { verified: true, offerId: offer, gameId: game, categoryId: service,
        status: rows.get(offer).status, statusCode: rows.get(offer).statusCode };
    },
    readOfferSnapshot: async options => {
      const state = await api.readOfferState(options);
      const editor = await api.readOfferEditor(state.offerId, { parseDocument: options.parseDocument });
      return { ...editor, ...state };
    },
    pauseOffer: async options => {
      const before = await api.readOfferState(options);
      if (["paused", "expired"].includes(before.status)) return { ...before, changed: false };
      if (before.status !== "on_sale") throw new Z2uError("OFFER_UNVERIFIED", "Offer sale state was not verified before deactivation");
      let writeError;
      try {
        // Observed group action uses URL-encoded fields and no CSRF token.
        // Only the literal off_line action is exposed; never an inverse toggle.
        await client.mutate("/sell/productAction", () => new URLSearchParams({ list_pk: before.offerId, list_action: "off_line" }), { csrf: false });
      } catch (error) { if (!error.uncertain) throw error; writeError = error; }
      let after;
      try { after = await api.readOfferState(options); }
      catch { throw new Z2uError("WRITE_UNCERTAIN", "Cannot verify offer deactivation", { uncertain: true }); }
      if (!["paused", "expired"].includes(after.status)) {
        throw writeError || new Z2uError("WRITE_UNCERTAIN", "Offer deactivation did not match readback", { uncertain: true });
      }
      return { ...after, changed: true };
    },
    editPausedOffer: async ({ priorSnapshot, desiredFields, parseDocument, maxPages = 100 }) => {
      const { verifyOfferSnapshot, validateOfferEditFields, buildOfferEditForm } = require("./offers");
      if (priorSnapshot?.verified !== true || priorSnapshot.status !== "paused" || priorSnapshot.statusCode !== 4) {
        throw new Z2uError("OFFER_UNVERIFIED", "Editing requires a verified paused offer snapshot");
      }
      const prior = structuredClone(priorSnapshot);
      const options = { offerId: id(prior.offerId), gameId: id(prior.gameId), categoryId: id(prior.categoryId), parseDocument, maxPages };
      const fields = validateOfferEditFields(desiredFields, options.offerId);
      const before = await api.readOfferSnapshot(options);
      // An old max=0 may be repaired here, but cannot authorize stocking or sale.
      if (before.statusCode !== 4 || !verifyOfferSnapshot(before, prior, { requireReady: false }).verified) {
        throw new Z2uError("OFFER_UNVERIFIED", "Offer changed from the reviewed paused snapshot");
      }
      const lastState = await api.readOfferState(options);
      if (lastState.statusCode !== 4) throw new Z2uError("OFFER_UNVERIFIED", "Offer is no longer paused");
      try {
        await client.mutate("/sell/manageListToUpdate", token => buildOfferEditForm(fields, token), { csrf: true });
      } catch (error) {
        if (!error.uncertain) throw error;
        // Applied writes can lose their acknowledgement. Readback decides; the
        // edit itself is never retried, including a server rejection envelope.
      }
      const readPausedAfterWrite = async () => {
        let state;
        try { state = await api.readOfferState(options); }
        catch { throw new Z2uError("WRITE_UNCERTAIN", "Cannot verify offer state after editing", { uncertain: true }); }
        if (state.status === "on_sale") {
          let paused = false;
          try { paused = (await api.pauseOffer(options)).verified === true; } catch { /* Remains uncertain and held. */ }
          throw new Z2uError("WRITE_UNCERTAIN", paused ? "Edit unexpectedly enabled the offer; deactivation was verified" : "Edit unexpectedly enabled the offer; deactivation is unverified", { uncertain: true });
        }
        if (state.statusCode !== 4) throw new Z2uError("WRITE_UNCERTAIN", "Paused offer state did not match readback", { uncertain: true });
        return state;
      };
      // Check immediately to contain unexpected activation, then again after
      // the complete editor read so the returned state is the latest evidence.
      await readPausedAfterWrite();
      let editor;
      try { editor = await api.readOfferEditor(options.offerId, { parseDocument }); }
      catch { throw new Z2uError("WRITE_UNCERTAIN", "Cannot verify complete offer fields after editing", { uncertain: true }); }
      const afterState = await readPausedAfterWrite();
      const after = { ...editor, ...afterState };
      const expected = { ...prior, title: fields.list_title, description: fields.list_description, fields, status: "paused" };
      if (afterState.statusCode !== 4 || !verifyOfferSnapshot(after, expected).verified) {
        throw new Z2uError("WRITE_UNCERTAIN", "Edited fields or paused state did not match readback", { uncertain: true });
      }
      return after;
    },
    readServices: gameId => client.readJson(STORAGE + "getServiceList", { game_id: id(gameId), category: "", type: "2" }),
    readStorageOptions: ({ gameId, categoryId }) => client.readJson(STORAGE + "getParentBygid",
      { game_id: id(gameId), category_id: id(categoryId), parent_id: "", disabled: "", type: "select" }),
    createStorage: options => {
      const fields = buildStorageFields(options);
      return client.mutate(STORAGE + "addstorage", () => form(fields));
    },
    importUnits: async options => {
      const fields = buildImportFields(options);
      const storage = await client.readJson(STORAGE + "getOnestorage", { id: fields.add_storage });
      if (!storage || !sameId(storage.id, fields.add_storage) || !enumIs(storage.is_repeat, 2) ||
          !enumIs(storage.type, options.kind === "account" ? 1 : 2)) {
        throw new Z2uError("STORAGE_MISMATCH", "Import requires the verified, nonrepeatable storage category of the correct type");
      }
      return client.mutate(STORAGE + "addproduct", () => form(fields));
    },
    reconcileUploadedUnits: async ({ storageId, gameId, categoryId, kind, units,
      parseDocument = html => new DOMParser().parseFromString(html, "text/html"), maxPages = 100 }) => {
      const category = id(storageId), game = id(gameId), service = id(categoryId);
      buildImportFields({ storageId, kind, units });
      if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError("Invalid maxPages");
      const markers = new Set();
      for (const unit of units) {
        text(unit.remark, "unique import marker", { max: 300 });
        if (markers.has(unit.remark)) throw new TypeError("Import markers must be unique");
        markers.add(unit.remark);
      }
      const productIds = new Set(), signatures = new Set(), queue = [1], visited = new Set();
      let total = null, complete = true;
      while (queue.length) {
        if (visited.size >= maxPages) { complete = false; break; }
        const page = queue.shift();
        if (visited.has(page)) continue;
        visited.add(page);
        const snapshot = extractStoragePage(parseDocument(await api.readStoragePage({ storageId: category, status: "", page })));
        if (snapshot.total === null || (total !== null && total !== snapshot.total)) { complete = false; break; }
        total = snapshot.total;
        const signature = snapshot.productIds.join(",");
        if (signatures.has(signature) || snapshot.productIds.some(value => !/^[1-9]\d*$/.test(value) || productIds.has(value))) { complete = false; break; }
        signatures.add(signature);
        snapshot.productIds.forEach(value => productIds.add(value));
        for (const next of snapshot.pages) if (!visited.has(next) && !queue.includes(next)) queue.push(next);
      }
      if (total !== productIds.size) complete = false;
      const matches = units.map(() => []);
      for (const productId of productIds) {
        const product = await api.readProduct(productId);
        if (!product || !sameId(product.id, productId) || !sameId(product.storage_id, category) || !sameId(product.gid, game) || !sameId(product.category_id, service)) {
          throw new Z2uError("STORAGE_MISMATCH", "Remote product identity or ownership did not match the requested storage");
        }
        units.forEach((unit, index) => {
          const identity = kind === "account" ? unit.account : unit.code;
          if (product.account === identity && String(product.password || "") === (kind === "account" ? unit.password : "") &&
              String(product.note || "") === unit.remark && String(product.remark || "") === (unit.otherInfo || "")) {
            matches[index].push({ unitIndex: index, productId, storageId: category, gameId: game, categoryId: service,
              ...stockEvidence(product) });
          }
        });
      }
      return { complete, total, observed: productIds.size,
        matched: matches.filter(rows => rows.length === 1).map(rows => rows[0]),
        missing: matches.flatMap((rows, index) => rows.length === 0 ? [index] : []),
        ambiguous: matches.flatMap((rows, index) => rows.length > 1 ? [index] : []) };
    },
    configureNativeDelivery: async options => {
      const fields = buildDeliveryFields(options);
      let writeError;
      try { await client.mutate(SELL + "submitDeliver", () => form(fields)); }
      catch (error) { if (!error.uncertain) throw error; writeError = error; }
      // A throttling error can accompany an applied write. Readback is evidence.
      let actual;
      try { actual = await client.readJson(SELL + "getProDetail", { id: fields.id }); }
      catch { throw new Z2uError("WRITE_UNCERTAIN", "Cannot verify native delivery configuration", { uncertain: true }); }
      if (!verifyDeliverySettings(actual, fields)) {
        throw writeError || new Z2uError("WRITE_UNCERTAIN", "Native delivery settings did not match readback", { uncertain: true });
      }
      return { verified: true, offerId: fields.id, storageId: fields.storage_id,
        automaticDeliveryEnabled: true, deactivateWhenEmpty: true, maxPurchaseQuantity: Number(fields.buy_more) };
    },
  };
  return Object.freeze(api);
}

module.exports = { STORAGE, SELL, buildStorageFields, buildImportFields, buildDeliveryFields, verifyDeliverySettings, stockEvidence, extractStoragePage, createVaultProtocol };
