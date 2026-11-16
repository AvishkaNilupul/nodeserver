"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { extractOrderPage, analyzeOrders, classifyStatus } = require("../utils/z2u/orderAudit");
const { browserScript } = require("../scripts/z2u-order-audit");

const order = (id, statusText = "Completed", totalText = "Total Amount: USD 1.20", extra = {}) => ({ orderId: `Z100000000${id}`, title: "Synthetic reward", dateText: "Date: 2026-01-02 03:04:05", statusText, totalText, quantity: null, ...extra });
const page = (orders, expectedTotal = orders.length, extra = {}) => ({ page: 1, orders, expectedTotal, ...extra });

test("gross sums exactly by currency, excludes canceled/refunded and never infers net", () => {
  const report = analyzeOrders([page([order(1), order(2, "Completed", "USD 0.10"), order(3, "Cancelled", "USD 90"), order(4, "Completed", "EUR 2.35"), order(5, "Refunded", "USD 10")])]);
  assert.equal(report.complete, true);
  assert.deepEqual(report.completedGrossByCurrency, { EUR: "2.35", USD: "1.30" });
  assert.equal(report.cancellationRate, 0.2);
  assert.equal(report.unknowns.quantity, 5);
  assert.match(report.accounting, /net profit are not inferred/);
  assert.ok(!JSON.stringify(report).includes("Z100000000"));
});

test("ambiguous money and new statuses remain explicit unknowns", () => {
  const report = analyzeOrders([page([order(1, "Completed", "$4.99"), order(2, "Completed", "USD 1,20"), order(3, "New seller state", "USD 10"), order(4, "Delivered", "USD 9")])]);
  assert.deepEqual(report.completedGrossByCurrency, {});
  assert.equal(report.unknowns.completedAmount, 2);
  assert.equal(report.unknowns.status, 1);
  assert.equal(report.statuses.delivered_unconfirmed, 1);
  assert.equal(classifyStatus("Canceled"), "canceled");
});

test("deduplicates overlap without inflating totals and flags conflicting/repeated pages", () => {
  const report = analyzeOrders([page([order(1)], 2), page([order(1), order(2)], 2, { page: 2 })]);
  assert.equal(report.duplicateRows, 1);
  assert.equal(report.completeness.observedOrders, 2);
  assert.equal(report.completedGrossByCurrency.USD, "2.40");
  const conflict = analyzeOrders([page([order(1)]), page([order(1, "Refunded")], 1, { page: 2 })]);
  assert.equal(conflict.complete, false);
  assert.ok(conflict.completeness.problems.includes("conflicting_duplicate_order"));
  assert.ok(conflict.completeness.problems.includes("repeated_order_page"));
});

test("truncated, gated, mismatched, changing and explicitly partial captures cannot be complete", () => {
  for (const input of [[], [page([order(1)], 78)], [page([order(1)], undefined, { expectedTotal: undefined })], [page([order(1)], 1, { pages: [1, 2] })], [page([order(1)], 1), page([order(2)], 2, { page: 2 })], { pages: [page([order(1)])], complete: false }]) {
    assert.equal(analyzeOrders(input).complete, false);
  }
  assert.equal(analyzeOrders([page([], 0)]).complete, true);
});

test("extractor is serializable and only emits its allowlisted fields", () => {
  const element = (textContent, href) => ({ textContent, getAttribute: () => href });
  const fields = { ".o-number a": element("Z1000000001", "/sellOrder?order_id=Z1000000001"), ".productInfo a": element(" Synthetic reward "), ".o-date": element("Date: 2026-01-02"), ".productStatus .smLabel": element("Completed"), ".productUnit": element("USD 1.20"), ".productTotalPrice": element("USD 1.20") };
  const row = { querySelector: (selector) => fields[selector] || null, textContent: "private buyer and delivery secret MUST NOT EXPORT" };
  const links = [element("All (78)", "/sellOrder/index/order_status/ALL"), element("Delivered (68)", "/sellOrder/index/order_status/DELIVERED"), element("Completed(68)", "/sellOrder/index?order_status=ALL&status=7"), element("4", "/sellOrder/index?order_status=ALL&page=4")];
  const document = { querySelectorAll: (selector) => selector === ".orderPanel" ? [row] : links };
  const extracted = vm.runInNewContext(`(${extractOrderPage.toString()})(document)`, { document, URL });
  assert.equal(extracted.counts.ALL, 78);
  assert.equal(extracted.counts.DELIVERED, 68);
  assert.equal(JSON.stringify(extracted.pages), "[1,4]");
  assert.equal(extracted.orders[0].quantity, null);
  assert.ok(!JSON.stringify(extracted).includes("secret"));
});

test("CLI consumes stdin, returns aggregate only, and exits 2 for partial audits", () => {
  const cli = path.join(__dirname, "../scripts/z2u-order-audit.js");
  const result = spawnSync(process.execPath, [cli], { input: JSON.stringify([page([order(1)])]), encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).complete, true);
  assert.ok(!result.stdout.includes("Z1000000001"));
  const partial = spawnSync(process.execPath, [cli], { input: JSON.stringify([page([order(1)], 78)]), encoding: "utf8" });
  assert.equal(partial.status, 2);
  assert.equal(JSON.parse(partial.stdout).complete, false);
});

test("generated browser audit parses and bounds same-origin reads without mutation routes", () => {
  const source = browserScript();
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /page > 100/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /capture/);
  assert.ok(!source.includes("form_submit"));
  assert.ok(!source.includes("document.cookie"));
});

async function runBrowserAudit(responses) {
  let captured, requests = 0;
  const browserURL = class extends URL {
    static createObjectURL(blob) { captured = blob; return "blob:synthetic"; }
    static revokeObjectURL() {}
  };
  const element = (textContent, href) => ({ textContent, getAttribute: () => href });
  const context = {
    URL: browserURL, Blob,
    location: { origin: "https://www.z2u.com" },
    console: { log() {} },
    setTimeout: (callback) => { callback(); return 0; },
    document: { body: { appendChild() {} }, createElement: () => ({ click() {}, remove() {} }) },
    fetch: async (url, options) => {
      assert.equal(options.credentials, "same-origin");
      assert.equal(url.origin, "https://www.z2u.com");
      const response = responses[requests++];
      if (!response) throw new Error("Unexpected request");
      return { ok: true, url: response.redirect || url.href, text: async () => JSON.stringify(response) };
    },
    DOMParser: class {
      parseFromString(source) {
        const data = JSON.parse(source);
        return {
          title: "Seller orders",
          querySelector: () => null,
          querySelectorAll(selector) {
            if (selector === "a[href]") return [element(`All (${data.total})`, "/sellOrder/index/order_status/ALL"), ...Array.from({ length: data.pages || 1 }, (_, i) => element(String(i + 1), `/sellOrder/index?order_status=ALL&page=${i + 1}`))];
            return data.orders.map((order) => ({ querySelector(selector) {
              return ({ ".o-number a": element(order.orderId, `/sellOrder?order_id=${order.orderId}`), ".productInfo a": element(order.title), ".o-date": element(order.dateText), ".productStatus .smLabel": element(order.statusText), ".productUnit": element("USD 1.20"), ".productTotalPrice": element(order.totalText) })[selector];
            } }));
          },
        };
      }
    },
  };
  await vm.runInNewContext(browserScript(), context);
  return { requests, capture: JSON.parse(await captured.text()) };
}

test("browser audit fetches discovered pages and downloads a complete sanitized capture", async () => {
  const { capture, requests } = await runBrowserAudit([{ total: 2, pages: 2, orders: [order(1)] }, { total: 2, pages: 2, orders: [order(2)] }]);
  assert.equal(requests, 2);
  assert.equal(capture.complete, true);
  assert.equal(analyzeOrders(capture).complete, true);
  assert.deepEqual(Object.keys(capture.pages[0].orders[0]).sort(), ["dateText", "orderId", "quantity", "statusText", "title", "totalText", "unitPriceText"]);
});

test("browser audit stops repeated pages, excessive pagination, and login redirects", async () => {
  const repeated = await runBrowserAudit([{ total: 2, pages: 2, orders: [order(1)] }, { total: 2, pages: 2, orders: [order(1)] }]);
  assert.equal(repeated.capture.complete, false);
  assert.equal(repeated.capture.pages.length, 1);
  assert.match(repeated.capture.errors[0], /repeated/);
  const bound = await runBrowserAudit([{ total: 2, pages: 101, orders: [order(1)] }]);
  assert.equal(bound.requests, 1);
  assert.equal(bound.capture.complete, false);
  assert.match(bound.capture.errors[0], /bound/);
  const login = await runBrowserAudit([{ redirect: "https://www.z2u.com/login", orders: [] }]);
  assert.equal(login.capture.complete, false);
  assert.equal(login.capture.pages.length, 0);
  assert.match(login.capture.errors[0], /redirected/);
});
