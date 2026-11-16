'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { analyzeOrders, parseMoney } = require('../utils/z2u/orderAudit');
const { browserScript } = require('../scripts/z2u-order-audit');
const order = n => ({ orderId: `Z10000000${n}`, title: 'Synthetic product', statusText: 'Completed', totalText: 'Total Amount: USD 1.50', dateText: '2026-11-16', quantity: null });

test('a malformed page count cannot borrow a valid count from another page', () => {
  for (const expectedTotal of ['2?', -1, 1.5, NaN]) {
    const result = analyzeOrders([
      { page: 1, expectedTotal: 2, orders: [order(1)], pages: [1, 2] },
      { page: 2, expectedTotal, orders: [order(2)], pages: [1, 2] },
    ]);
    assert.equal(result.complete, false, `malformed total ${String(expectedTotal)}`);
  }
});

test('captured count and explicit expected count must agree', () => {
  const result = analyzeOrders([{ page: 1, expectedTotal: 1, counts: { ALL: 78 }, orders: [order(1)] }]);
  assert.equal(result.complete, false);
});

test('spaced numeric suffixes cannot silently truncate money', () => {
  for (const value of ['USD 1 234.56', 'USD 1\u00a0234.56', 'Total Amount: USD 12 34', 'USD 1 ,234.56']) {
    assert.equal(parseMoney(value), null, value);
  }
  assert.equal(parseMoney('Total Amount: USD 1,234.56').units, 1234560000n);
});

test('unexpected browser exceptions do not export private exception text', async () => {
  let captured;
  const secret = 'UNEXPECTED_PRIVATE_COOKIE_VALUE';
  const FakeURL = class extends URL {
    static createObjectURL(blob) { captured = blob; return 'blob:synthetic'; }
    static revokeObjectURL() {}
  };
  await vm.runInNewContext(browserScript(), {
    URL: FakeURL, Blob,
    location: { origin: 'https://www.z2u.com' },
    fetch: async () => { throw new Error(secret); },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    console: { log() {} }, setTimeout: callback => { callback(); return 0; },
  });
  const text = await captured.text();
  assert.equal(JSON.parse(text).complete, false);
  assert.ok(!text.includes(secret));
});
