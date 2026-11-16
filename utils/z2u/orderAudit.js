"use strict";

// Self-contained: serialized into the browser audit without importing Node code.
function extractOrderPage(document) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const text = (node, selector) => clean(node.querySelector(selector)?.textContent);
  const orders = [...document.querySelectorAll(".orderPanel")].map((row) => {
    const link = row.querySelector(".o-number a");
    const href = link?.getAttribute("href") || "";
    const orderId = /[?&]order_id=(Z\d+)/i.exec(href)?.[1] || /\bZ\d{9,}\b/.exec(clean(link?.textContent))?.[0] || "";
    return {
      orderId,
      title: text(row, ".productInfo a"),
      dateText: text(row, ".o-date"),
      statusText: text(row, ".productStatus .smLabel"),
      unitPriceText: text(row, ".productUnit"),
      totalText: text(row, ".productTotalPrice"),
      quantity: null,
    };
  });
  const counts = {};
  const pages = new Set([1]);
  for (const link of document.querySelectorAll("a[href]")) {
    let url;
    try { url = new URL(link.getAttribute("href"), "https://www.z2u.com"); } catch { continue; }
    if (url.origin !== "https://www.z2u.com" || !/^\/sellOrder\/index(?:\/|$)/.test(url.pathname)) continue;
    const state = /\/order_status\/([A-Z_]+)\/?$/.exec(url.pathname)?.[1] || url.searchParams.get("order_status");
    const count = /\(\s*(\d+)\s*\)/.exec(clean(link.textContent));
    // Subfilters (e.g. status=7) must not overwrite the total for ALL.
    if (state && count && !url.searchParams.has("status") && !url.searchParams.has("page")) counts[state] = Number(count[1]);
    const page = Number(url.searchParams.get("page"));
    if (state === "ALL" && !url.searchParams.has("status") && Number.isInteger(page) && page > 0) pages.add(page);
  }
  return { orders, counts, pages: [...pages].sort((a, b) => a - b) };
}

function classifyStatus(value) {
  const status = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (/^completed$/.test(status)) return "completed";
  if (/^cancel(?:l)?ed$/.test(status)) return "canceled";
  if (/^(refunded|fully refunded)$/.test(status)) return "refunded";
  if (/^(partially refunded|partial refund)$/.test(status)) return "partially_refunded";
  if (/^(disputed|in dispute|dispute|under dispute)$/.test(status)) return "disputed";
  if (/^(delivered|wait for confirmed|waiting for confirmation)$/.test(status)) return "delivered_unconfirmed";
  if (/^(preparing|delivering|pending delivery|waiting for delivery|waiting for buyer reply|pending feedback)$/.test(status)) return "pending";
  return "unknown";
}

function parseMoney(value) {
  const source = String(value || "").replace(/\s+/g, " ").trim();
  const matches = [...source.matchAll(/\b([A-Z]{3})\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?)\b/g)];
  if (matches.length !== 1) return null;
  const [, currency, raw] = matches[0];
  // Do not accidentally accept the first segment of a malformed amount.
  const rest = source.slice(matches[0].index + matches[0][0].length);
  if (/^\s*[\d.,]/.test(rest)) return null;
  const [whole, fraction = ""] = raw.replace(/,/g, "").split(".");
  const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0")) * (whole.startsWith("-") ? -1n : 1n);
  return { currency, units };
}

function addMoney(totals, money) {
  totals[money.currency] = (totals[money.currency] || 0n) + money.units;
}

function displayMoney(totals) {
  return Object.fromEntries(Object.entries(totals).sort().map(([currency, units]) => {
    const sign = units < 0n ? "-" : "";
    const amount = units < 0n ? -units : units;
    const fraction = String(amount % 1000000n).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
    return [currency, `${sign}${amount / 1000000n}.${fraction}`];
  }));
}

function analyzeOrders(input) {
  const pages = Array.isArray(input) ? input : input?.pages;
  if (!Array.isArray(pages)) throw new TypeError("Expected an array of extracted order pages");
  const byId = new Map();
  const expectedTotals = new Set();
  const discoveredPages = new Set([1]);
  const observedPages = new Set();
  const problems = new Set();
  let duplicateRows = 0, invalidRows = 0;
  for (const [index, page] of pages.entries()) {
    if (!page || !Array.isArray(page.orders)) throw new TypeError("Each page must contain an orders array");
    const pageNo = page.page == null ? index + 1 : page.page;
    if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > 100 || observedPages.has(pageNo)) problems.add("invalid_or_repeated_page_number");
    observedPages.add(pageNo);
    for (const n of page.pages || []) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 100) { problems.add("invalid_pagination"); continue; }
      for (let required = 1; required <= n; required++) discoveredPages.add(required);
    }
    const totals = [];
    if (Object.hasOwn(page, "expectedTotal")) totals.push(page.expectedTotal);
    if (page.counts && Object.hasOwn(page.counts, "ALL")) totals.push(page.counts.ALL);
    if (!totals.length) problems.add("missing_page_total");
    for (const total of totals) {
      if (!Number.isSafeInteger(total) || total < 0) problems.add("invalid_page_total");
      else expectedTotals.add(total);
    }
    let fresh = 0;
    for (const row of page.orders) {
      if (!row || !/^Z\d{9,}$/.test(row.orderId || "")) { invalidRows++; continue; }
      if (byId.has(row.orderId)) {
        duplicateRows++;
        const previous = byId.get(row.orderId);
        if (["title", "statusText", "totalText", "dateText"].some((key) => previous[key] !== row[key])) problems.add("conflicting_duplicate_order");
      } else { byId.set(row.orderId, row); fresh++; }
    }
    if (page.orders.length && !fresh) problems.add("repeated_order_page");
  }
  const expectedTotal = expectedTotals.size === 1 ? [...expectedTotals][0] : null;
  if (!pages.length) problems.add("no_pages");
  if (expectedTotal === null) problems.add(expectedTotals.size ? "inconsistent_total" : "missing_total");
  if (expectedTotal !== null && expectedTotal !== byId.size) problems.add("order_count_mismatch");
  if ([...discoveredPages].some((n) => !observedPages.has(n))) problems.add("missing_pages");
  if (invalidRows) problems.add("unreadable_order_rows");
  if (!Array.isArray(input) && input.complete === false) problems.add("capture_marked_partial");
  const statuses = {}, gross = {}, products = new Map(), dates = [];
  let unknownStatus = 0, missingCompletedAmounts = 0, missingTitles = 0, unknownDates = 0;
  for (const row of byId.values()) {
    const status = classifyStatus(row.statusText);
    statuses[status] = (statuses[status] || 0) + 1;
    if (status === "unknown") unknownStatus++;
    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "[Unknown product]";
    if (title === "[Unknown product]") missingTitles++;
    if (!products.has(title)) products.set(title, { title, orders: 0, statuses: {}, completedGross: {} });
    const product = products.get(title);
    product.orders++;
    product.statuses[status] = (product.statuses[status] || 0) + 1;
    if (status === "completed") {
      const money = parseMoney(row.totalText);
      if (money && money.units >= 0n) { addMoney(gross, money); addMoney(product.completedGross, money); }
      else missingCompletedAmounts++;
    }
    const date = /\b\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?\b/.exec(String(row.dateText || ""))?.[0];
    if (date) dates.push(date); else unknownDates++;
  }
  dates.sort();
  const total = byId.size;
  return {
    complete: problems.size === 0,
    completeness: { expectedOrders: expectedTotal, observedOrders: total, pages: observedPages.size, problems: [...problems].sort() },
    duplicateRows,
    statuses,
    completedGrossByCurrency: displayMoney(gross),
    cancellationRate: total ? (statuses.canceled || 0) / total : null,
    cancellationRateBasis: "canceled orders / all observed unique orders",
    dates: { earliest: dates[0] || null, latest: dates.at(-1) || null, timezone: "not established; source display time" },
    unknowns: { status: unknownStatus, completedAmount: missingCompletedAmounts, title: missingTitles, date: unknownDates, quantity: [...byId.values()].filter((row) => row.quantity == null).length },
    products: [...products.values()].map((product) => ({ ...product, completedGross: displayMoney(product.completedGross) })).sort((a, b) => b.orders - a.orders || a.title.localeCompare(b.title)),
    accounting: "Completed order gross only; fees, refunds, reserves, withdrawals and net profit are not inferred.",
  };
}

module.exports = { extractOrderPage, analyzeOrders, classifyStatus, parseMoney };
