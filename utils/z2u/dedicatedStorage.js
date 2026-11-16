"use strict";

const { Z2uError } = require("./client");
const { extractStoragePage } = require("./vaultProtocol");

const fail = () => { throw new Z2uError("STORAGE_DEDICATION_UNVERIFIED", "Fresh empty storage provenance and exclusive observed offer linkage are required"); };
function decimal(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  fail();
}
function sameId(value, expected) { try { return decimal(value) === expected; } catch { return false; } }
function zero(value) { return value === 0 || value === "0"; }
function typed(value, expected) { return value === expected || value === String(expected); }
function normalized(node) { return node.textContent.replace(/\s+/g, " ").trim(); }

/** Observed category row metadata; no category response exposes inverse links. */
function extractCategoryEvidence(document, storageId) {
  storageId = decimal(storageId);
  const rows = [...document.querySelectorAll(`#menus-table #node-${storageId}`)];
  if (rows.length !== 1) fail();
  const row = rows[0], actions = [...row.querySelectorAll(".action-btn-group[data-id]")];
  const checks = [...row.querySelectorAll(".checkone[data]")];
  if (actions.length !== 1 || checks.length !== 1 || checks[0].getAttribute("data") !== storageId || actions[0].getAttribute("data-id") !== storageId) fail();
  const cells = [...row.children].map(normalized);
  const count = label => {
    const matched = cells.map(value => new RegExp(`^${label} (0|[1-9]\\d*)$`).exec(value)).filter(Boolean);
    if (matched.length !== 1 || !Number.isSafeInteger(Number(matched[0][1]))) fail();
    return Number(matched[0][1]);
  };
  return { storageId, gameId: decimal(actions[0].getAttribute("data-gid")), categoryId: decimal(actions[0].getAttribute("data-category_id")),
    type: actions[0].getAttribute("data-type"), stock: count("Stock"), used: count("Used"), total: count("Totals") };
}

/**
 * Read-only, before the first bootstrap import. Local provenance records the
 * verified category creation intent; native create_t has no known timezone.
 * Native exclusivity is observed by scanning every offer in the same explicit
 * game/service group, including paused/expired offers. No hidden link API exists.
 */
async function verifyDedicatedStorage({ protocol, offer, provenance, parseDocument = html => new DOMParser().parseFromString(html, "text/html"),
  now = Date.now, maxPages = 100 }) {
  if (!offer || !provenance || provenance.version !== 1 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) fail();
  const expected = {};
  for (const name of ["offerId", "storageId", "gameId", "categoryId"]) {
    expected[name] = decimal(offer[name]);
    if (provenance[name] !== expected[name]) fail();
  }
  if (typeof provenance.name !== "string" || !provenance.name.trim() || provenance.name.length > 300 || provenance.name.includes("\0")) fail();
  const createdAt = typeof provenance.createdAt === "string" ? Date.parse(provenance.createdAt) : NaN;
  const currentTime = now();
  if (!Number.isSafeInteger(currentTime) || !Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== provenance.createdAt ||
      createdAt > currentTime + 5000 || currentTime - createdAt > 86400000) fail();
  const storage = await protocol.readStorage(expected.storageId);
  if (!storage || !sameId(storage.id, expected.storageId) || !sameId(storage.gid, expected.gameId) ||
      !sameId(storage.category_id, expected.categoryId) || storage.name !== provenance.name || !zero(storage.parent_id) ||
      !typed(storage.type, 1) || !typed(storage.is_repeat, 2)) fail();
  const options = await protocol.readStorageOptions(expected);
  if (typeof options !== "string") fail();
  const nodes = [...parseDocument(`<select>${options}</select>`).querySelectorAll("option")];
  const matchingId = nodes.filter(node => node.getAttribute("value") === expected.storageId);
  const matchingName = nodes.filter(node => normalized(node) === provenance.name);
  if (matchingId.length !== 1 || matchingName.length !== 1 || matchingId[0] !== matchingName[0] ||
      matchingId[0].hasAttribute("disabled") || !matchingId[0].classList.contains("is_last") ||
      matchingId[0].getAttribute("data-num") !== "0" || matchingId[0].getAttribute("data-type") !== "1") fail();
  const index = extractCategoryEvidence(parseDocument(await protocol.readCategoriesPage()), expected.storageId);
  if (index.gameId !== expected.gameId || index.categoryId !== expected.categoryId || index.type !== "1" || index.stock !== 0 || index.used !== 0 || index.total !== 0) fail();
  const active = extractStoragePage(parseDocument(await protocol.readStoragePage({ storageId: expected.storageId, status: "", page: 1 })));
  if (active.total !== 0 || active.productIds.length !== 0 || active.pages.some(page => page !== 1)) fail();

  const queue = [1], visited = new Set(), rows = new Map(), signatures = new Set();
  const statuses = { paused: 4, expired: 5, on_sale: 1 };
  while (queue.length) {
    if (visited.size >= maxPages) fail();
    const page = queue.shift(); visited.add(page);
    const group = await protocol.readOfferGroup({ gameId: expected.gameId, categoryId: expected.categoryId, page, parseDocument });
    if (group?.valid !== true || group.context?.gameId !== expected.gameId || group.context?.categoryId !== expected.categoryId ||
        !Array.isArray(group.offers) || !group.offers.length || !Array.isArray(group.pages)) fail();
    const signature = group.offers.map(row => row.offerId).join(",");
    if (signatures.has(signature)) fail();
    signatures.add(signature);
    for (const row of group.offers) {
      const offerId = decimal(row.offerId);
      if (rows.has(offerId) || !Object.hasOwn(statuses, row.status) || statuses[row.status] !== row.statusCode) fail();
      rows.set(offerId, row);
    }
    for (const next of group.pages) {
      if (!Number.isSafeInteger(next) || next < 1 || next > maxPages) fail();
      // Numbered pagination may show only the first and last page. Every
      // intervening page must be inspected to rule out another linked offer.
      for (let candidate = 1; candidate <= next; candidate++) {
        if (!visited.has(candidate) && !queue.includes(candidate)) queue.push(candidate);
      }
    }
  }
  if (rows.get(expected.offerId)?.status !== "paused") fail();
  for (const offerId of rows.keys()) {
    const settings = await protocol.readOfferDelivery(offerId);
    if (!settings || !sameId(settings.id, offerId) || (settings.product_id !== undefined && !sameId(settings.product_id, offerId))) fail();
    const linked = zero(settings.storage_id) ? "0" : decimal(settings.storage_id);
    if (offerId !== expected.offerId && linked === expected.storageId) fail();
    if (offerId === expected.offerId && !["0", expected.storageId].includes(linked)) fail();
  }
  return { verified: true, ...expected };
}

module.exports = { extractCategoryEvidence, verifyDedicatedStorage };
