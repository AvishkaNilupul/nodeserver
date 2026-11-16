#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { extractOrderPage, analyzeOrders } = require("../utils/z2u/orderAudit");

function browserScript() {
  return `/* Run on the signed-in https://www.z2u.com seller page.
Read-only requests; downloads sanitized order metadata, never cookies or buyers. */
(async () => {
  "use strict";
  if (location.origin !== "https://www.z2u.com") throw new Error("Open the signed-in Z2U seller site first");
  const extract = ${extractOrderPage.toString()};
  const result = { pages: [], complete: false, errors: [] };
  const seenOrders = new Set();
  const auditErrors = new WeakSet();
  const fail = (message) => { const error = new Error(message); auditErrors.add(error); throw error; };
  let lastPage = 1, expected = null;
  try {
    for (let page = 1; page <= lastPage; page++) {
      if (page > 100) fail("Audit exceeded the 100-page bound");
      if (page > 1) await new Promise(resolve => setTimeout(resolve, 700));
      const url = new URL("/sellOrder/index", location.origin);
      url.searchParams.set("order_status", "ALL");
      url.searchParams.set("page", String(page));
      const response = await fetch(url, { credentials: "same-origin", redirect: "follow" });
      const finalUrl = new URL(response.url);
      if (!response.ok || finalUrl.origin !== location.origin || !/^\\/sellOrder(?:\\/|$)/.test(finalUrl.pathname)) fail("Seller page unavailable or session redirected");
      const document = new DOMParser().parseFromString(await response.text(), "text/html");
      if (document.querySelector('input[type="password"], iframe[src*="captcha"], #challenge-form') || /just a moment|access denied|sign in|log in/i.test(document.title)) fail("Login or verification gate encountered");
      const extracted = extract(document);
      const total = extracted.counts.ALL;
      if (!Number.isSafeInteger(total) || total < 0) fail("Order total unavailable; possible privacy or login gate");
      if (expected !== null && total !== expected) fail("Order total changed during audit; repeat the capture");
      expected = total;
      if (extracted.orders.some(order => !order.orderId || !order.title || !order.statusText)) fail("Order markup changed; extraction incomplete");
      const fresh = extracted.orders.filter(order => !seenOrders.has(order.orderId));
      if (total > 0 && !fresh.length) fail("Empty or repeated order page");
      if (fresh.length !== extracted.orders.length) fail("Overlapping order pages; repeat the capture");
      for (const order of fresh) seenOrders.add(order.orderId);
      result.pages.push({ page, ...extracted, expectedTotal: total });
      lastPage = Math.max(lastPage, ...extracted.pages);
      if (lastPage > 100) fail("Discovered pagination exceeds the 100-page bound");
    }
    if (seenOrders.size !== expected) fail("Order count mismatch; captured pages are partial");
    result.complete = true;
  } catch (error) {
    // Only errors created here may export text; unexpected exceptions can carry secrets.
    result.errors.push(auditErrors.has(error) ? error.message : "Unexpected capture failure; no private exception details exported");
  }
  const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = "z2u-order-audit-" + (result.complete ? "complete" : "partial") + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  console.log({ complete: result.complete, pages: result.pages.length, orders: seenOrders.size, errors: result.errors });
})();\n`;
}

function main(args) {
  if (args.length === 1 && args[0] === "--browser-script") {
    process.stdout.write(browserScript());
    return;
  }
  if (args.includes("--help")) {
    process.stdout.write("Usage: node scripts/z2u-order-audit.js [--input FILE]\n       node scripts/z2u-order-audit.js --browser-script\nReads extracted page JSON from FILE or stdin; prints aggregate totals without order or buyer identifiers.\nKeep downloaded audit files outside the public repository.\n");
    return;
  }
  if (args.length && !(args.length === 2 && args[0] === "--input" && args[1])) throw new Error("Invalid arguments; use --help");
  let input;
  try { input = JSON.parse(fs.readFileSync(args.length ? args[1] : 0, "utf8")); }
  catch { throw new Error("Cannot read valid audit JSON from input"); }
  const report = analyzeOrders(input);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!report.complete) process.exitCode = 2;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write("Z2U audit: " + error.message + "\n"); process.exitCode = 1; }
}

module.exports = { browserScript, main };
