"use strict";

const { extractOfferConstraints } = require("./lifecycle");

const SCALARS = ["list_pk", "list_title", "list_description", "list_online_date", "list_term_of_validity",
  "insurance", "list_max_num", "list_attr_id", "list_platform_id", "list_area_id", "list_currency_type",
  "list_unit_price", "list_stock_num", "list_less_num", "buy_multiple"];
const ARRAYS = ["list_device_id[]", "list_transaction_mode[]", "listPic[]"];
const KNOWN = new Set([...SCALARS, ...ARRAYS, "__token__"]);

function decimal(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}

function controlValues(control) {
  const type = String(control.type || "").toLowerCase();
  const flag = (node, name) => typeof node?.[name] === "boolean" ? node[name] : !!node?.hasAttribute?.(name);
  if (flag(control, "disabled") || ["submit", "button", "reset", "file"].includes(type)) return [];
  if (["checkbox", "radio"].includes(type) && !flag(control, "checked")) return [];
  if (String(control.tagName).toLowerCase() === "select") {
    const options = [...control.options];
    let selected = options.filter(option => flag(option, "selected"));
    // Static DOM parsers may not implement the browser's initial single-select
    // selection. Do not override a real browser's explicit selectedIndex=-1.
    if (!selected.length && control.selectedIndex === undefined && !flag(control, "multiple") &&
        Number(control.getAttribute("size") || 0) <= 1) {
      const first = options.find(option => !flag(option, "disabled") && !flag(option.parentElement, "disabled"));
      if (first) selected = [first];
    }
    return selected.filter(option => !flag(option, "disabled") && !flag(option.parentElement, "disabled")).map(option => option.value);
  }
  if (String(control.tagName).toLowerCase() === "textarea") {
    // LinkeDOM preserves raw RCDATA entities in textarea.value; browsers have
    // already decoded them. Detect that behavior rather than decoding twice.
    const document = control.ownerDocument;
    const probe = document.createElement("textarea");
    probe.innerHTML = "&amp;";
    if (probe.value === "&amp;") {
      const decoder = document.createElement("span");
      // Escape literal markup before HTML parsing so only entities are decoded.
      decoder.innerHTML = control.value.replace(/</g, "&lt;");
      return [decoder.textContent.replace(/\r\n?/g, "\n")];
    }
    // Multipart form submission normalizes newlines to CRLF. HTML textarea
    // values exposed by browsers normalize them back to LF; LinkeDOM does not.
    return [control.value.replace(/\r\n?/g, "\n")];
  }
  return [control.value];
}

/** Public listing contents only. Authentication tokens never enter snapshots. */
function extractOfferEditor(document) {
  const constraints = extractOfferConstraints(document);
  const forms = [...document.querySelectorAll("form#form")];
  if (forms.length !== 1) return { valid: false, constraints, fields: {}, unknownFields: [] };
  const fields = {}, unknownFields = [], malformedFields = [];
  const controls = [...forms[0].querySelectorAll("input[name],select[name],textarea[name],button[name]")];
  const nameOf = control => control.getAttribute("name");
  for (const name of SCALARS) {
    const matched = controls.filter(control => nameOf(control) === name);
    const values = matched.flatMap(controlValues);
    if (matched.length !== 1 || values.length !== 1 || typeof values[0] !== "string") malformedFields.push(name);
    else fields[name] = values[0];
  }
  for (const name of ARRAYS) {
    fields[name] = controls.filter(control => nameOf(control) === name).flatMap(controlValues);
    if (fields[name].some(value => typeof value !== "string")) malformedFields.push(name);
  }
  for (const control of controls) {
    const name = nameOf(control);
    if (!KNOWN.has(name) && !unknownFields.includes(name)) unknownFields.push(name);
  }
  return { valid: malformedFields.length === 0 && unknownFields.length === 0 && !!constraints.offerId,
    offerId: constraints.offerId, title: fields.list_title ?? null, description: fields.list_description ?? null,
    fields, unknownFields, malformedFields, constraints, gameId: null, categoryId: null, status: "unknown" };
}

/** Group identity comes from the page's own navigation script, never its title. */
function extractOfferGroup(document) {
  const contexts = new Map();
  for (const script of [...document.querySelectorAll("script:not([src])")]) {
    for (const match of script.textContent.matchAll(/https:\/\/www\.z2u\.com\/sell\/manageList\?[^\s"'`<>]+/g)) {
      try {
        const url = new URL(match[0]);
        const gameId = decimal(url.searchParams.get("game")), categoryId = decimal(url.searchParams.get("service"));
        if (gameId && categoryId) contexts.set(`${gameId}:${categoryId}`, { gameId, categoryId });
      } catch { /* A malformed script URL cannot prove context. */ }
    }
  }
  const context = contexts.size === 1 ? [...contexts.values()][0] : null;
  const offers = [], seen = new Set();
  let valid = !!context;
  const states = { "1": "on_sale", "4": "paused", "5": "expired" };
  for (const row of document.querySelectorAll(".div-table-row[data]")) {
    const offerId = decimal(row.getAttribute("data"));
    const badges = [...row.querySelectorAll(".set_status[data-value]")];
    const stateCode = badges.length === 1 ? badges[0].getAttribute("data-value") : null;
    if (!offerId || seen.has(offerId) || !Object.hasOwn(states, stateCode)) valid = false;
    if (offerId) seen.add(offerId);
    offers.push({ offerId, statusCode: Object.hasOwn(states, stateCode) ? Number(stateCode) : null,
      status: states[stateCode] || "unknown" });
  }
  const pages = new Set([1]);
  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      const url = new URL(anchor.getAttribute("href"), "https://www.z2u.com");
      if (url.origin !== "https://www.z2u.com" || url.pathname !== "/sell/manageList") continue;
      const gameId = url.searchParams.get("game"), categoryId = url.searchParams.get("service");
      if (context && ((gameId && gameId !== context.gameId) || (categoryId && categoryId !== context.categoryId))) continue;
      const value = url.searchParams.get("page");
      if (value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) pages.add(Number(value));
    } catch { /* Ignore links that cannot identify a group page. */ }
  }
  return { valid, context, offers, pages: [...pages].sort((a, b) => a - b) };
}

function verifyOfferSnapshot(actual, expected, { requireReady = true } = {}) {
  const mismatches = [];
  if (actual?.verified !== true) mismatches.push("snapshot_unverified");
  for (const name of ["offerId", "gameId", "categoryId"]) {
    if (!decimal(expected?.[name]) || actual?.[name] !== decimal(expected[name])) mismatches.push(name);
  }
  for (const name of ["title", "description", "status"]) {
    if (typeof expected?.[name] !== "string" || actual?.[name] !== expected[name]) mismatches.push(name);
  }
  // Every observed form field must be specified; a partial expected object must
  // not silently approve an unintended platform, delivery mode, image or price.
  for (const name of [...SCALARS, ...ARRAYS]) {
    if (!Object.hasOwn(expected?.fields || {}, name) || JSON.stringify(actual?.fields?.[name]) !== JSON.stringify(expected.fields[name])) mismatches.push(name);
  }
  if (requireReady && actual?.constraints?.ready !== true) mismatches.push("purchase_constraints");
  return { verified: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}

/** A complete observed form, copied before async preflight to prevent drift. */
function validateOfferEditFields(input, offerId) {
  const keys = [...SCALARS, ...ARRAYS];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
      Object.keys(input).some(key => !keys.includes(key))) throw new TypeError("Complete observed offer fields required");
  const validText = value => typeof value === "string" && value.length <= 100000 && !value.includes("\0");
  const result = {};
  for (const name of SCALARS) {
    if (!Object.hasOwn(input, name) || !validText(input[name])) throw new TypeError(`Invalid ${name}`);
    result[name] = input[name];
  }
  result.list_description = result.list_description.replace(/\r\n?/g, "\n");
  for (const name of ARRAYS) {
    if (!Object.hasOwn(input, name) || !Array.isArray(input[name]) || input[name].length > 100 ||
        input[name].some(value => !validText(value))) throw new TypeError(`Invalid ${name}`);
    result[name] = [...input[name]];
  }
  if (!decimal(offerId) || result.list_pk !== decimal(offerId)) throw new TypeError("Offer identity cannot change");
  if (!result.list_title.trim() || !result.list_description.trim()) throw new TypeError("Listing title and description are required");
  const integer = name => /^(0|[1-9]\d*)$/.test(result[name]) && Number.isSafeInteger(Number(result[name])) ? Number(result[name]) : null;
  const maximum = integer("list_max_num"), minimum = integer("list_less_num"), stock = integer("list_stock_num");
  if (maximum === null || maximum < 1 || minimum === null || minimum < 1 || minimum > maximum || stock === null) {
    throw new TypeError("Finite positive purchase limits and whole stock are required");
  }
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(result.list_unit_price) || !Number.isFinite(Number(result.list_unit_price)) || Number(result.list_unit_price) <= 0) {
    throw new TypeError("A positive listing price is required");
  }
  return result;
}

function buildOfferEditForm(fields, token) {
  if (typeof token !== "string" || !token) throw new TypeError("Fresh CSRF token required");
  const body = new FormData();
  for (const name of SCALARS) body.append(name, fields[name]);
  for (const name of ARRAYS) for (const value of fields[name]) body.append(name, value);
  if (fields["list_transaction_mode[]"].length === 0) body.append("list_transaction_mode", "");
  body.append("__token__", token);
  return body;
}

module.exports = { SCALARS, ARRAYS, extractOfferEditor, extractOfferGroup, verifyOfferSnapshot, validateOfferEditFields, buildOfferEditForm };
