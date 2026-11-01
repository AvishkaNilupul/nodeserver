// utils/codeShop/vouchers.js — store credit is never sold as a game's code.
// Pure: every name here is made up or copied from a real reward title.
const test = require("node:test");
const assert = require("node:assert/strict");

const { findVoucher, isVoucher } = require("../utils/codeShop/vouchers");

test("store credit is found in Korean and English names", () => {
  for (const [name, hit] of [
    ["넥슨캐시 3,000원", "넥슨캐시"],
    ["넥슨 캐시 5,000원", "넥슨 캐시"],
    ["Nexon Cash 3,000 KRW", "Nexon Cash"],
    ["네이버 페이 5천원", "네이버 페이"],
    ["Naver Pay 5,000 KRW", "Naver Pay"],
    ["네이버페이 포인트 1만원", "네이버페이"],
    ["문화상품권 5,000원", "상품권"],
    ["Google Play Gift Card $10", "Gift Card"],
    ["구글 플레이 기프트 코드", "구글 플레이 기프트"],
    ["별풍선 100개", "별풍선"],
    ["1,000 치즈", "1,000 치즈"],
    ["3,000원 쿠폰", "3,000원"],
    ["10,000 KRW voucher", "10,000 KRW"],
  ]) {
    assert.equal(findVoucher(name), hit, name);
  }
});

test("game rewards are not store credit", () => {
  for (const name of [
    "Esports Loot Box",
    "OWCS Home Sombra Skin",
    "(Week 2) 1 Container + 1 Keycard",
    "(2주차) 컨테이너 1개 + 키카드 1개",
    "Gems + Bonus Item I",
    "Prost Spray",
    "치즈 스프레이 아이콘", // "cheese spray icon": a name, not an amount
    "5원소 무기 상자", // 원소 = element, not won
    "Legendary Loot Box",
    "Drops Token",
    "2,000 Gems",
    "Battle Pass Tier Skip",
  ]) {
    assert.equal(findVoucher(name), null, name);
  }
});

test("isVoucher checks every value it is given; blanks are fine", () => {
  assert.equal(isVoucher("", null, undefined), false);
  assert.equal(isVoucher("Prost Spray", "넥슨캐시 3,000원"), true);
  assert.equal(isVoucher("Prost Spray", "Banana Cat Spray"), false);
});
