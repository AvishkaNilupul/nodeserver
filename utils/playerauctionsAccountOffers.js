// Contract read from member.playerauctions.com's main-CC7ETF6Q and
// chunk-VHE4BCTG / W43HQTOV / AZ263OFB on 2026-10-30.
const crypto = require("node:crypto");
const mp = require("./marketplaces");
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0hnNIIDBLreG3t1lKWWZBxkZ+rhRUtRJDC1kj96I12HuBabjmQPXAZKwSTC5R+sK0zkQ7gKAvKisFvCwNg7bokdLRb/i/Et3GR6XTMBxZo1tLxiMp14SYDE0Q3+B/oKEFibXEiRwUiBywfDu/ps/Xmf5wQgoMiP1ErP1ik4MSBQIDAQAB
-----END PUBLIC KEY-----`;
function password(value) {
  // forge publicKey.encrypt uses RSAES-PKCS1-v1_5 by default.
  return crypto
    .publicEncrypt(
      { key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(String(value || "")),
    )
    .toString("base64");
}
function contact(value = {}, original = false) {
  const keys = original
    ? ["firstName", "lastName", "phone", "email", "city", "country"]
    : ["phone", "email", "city", "country"];
  const out = {};
  for (const k of keys) {
    out[k] = String(value[k] || "").trim();
    if (!out[k])
      throw new Error(
        "PlayerAuctions needs " +
          (original ? "original" : "current") +
          " owner " +
          k,
      );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email))
    throw new Error("Invalid owner email");
  if (!/^[0-9\-., ()]{9,17}$/.test(out.phone))
    throw new Error(
      "Owner phone must have 9 to 17 digits or phone punctuation",
    );
  return out;
}
function body(opts) {
  const price = Number(opts.priceUsd);
  if (
    !Number.isFinite(price) ||
    price < 5 ||
    Math.abs(Math.round(price * 100) - price * 100) > 1e-7
  )
    throw new Error(
      "PlayerAuctions price must be at least $5, with at most two decimal places",
    );
  const original = contact(opts.original, true);
  const current = contact(opts.current || opts.original);
  const title = String(opts.title || "").trim();
  if (!/epic games/i.test(title))
    throw new Error("Title must include Epic Games");
  if (!title || title.length > 150 || /[^\x20-\x7e]/.test(title))
    throw new Error("Title must be 1 to 150 ASCII characters");
  if (!opts.login || !opts.password || !opts.characterName)
    throw new Error("Epic login, password and display name are required");
  if (String(opts.instruction || "").length >= 500)
    throw new Error("Delivery instructions must be under 500 characters");
  return {
    gameId: 9310,
    serverId: 9311,
    categoryId: 9311,
    price,
    sellerAftersaleProtection: 14,
    offerDuration: 30,
    title,
    offerDesc: String(opts.description || ""),
    screenShot: "",
    agreeCheck: true,
    isAgree: true,
    isAuto: true,
    actionType: "",
    autoDelivery: {
      loginName: opts.login,
      retypeLoginName: opts.login,
      password: password(opts.password),
      retypePassword: password(opts.password),
      characterName: opts.characterName,
      isInfoSame: !opts.current,
      original,
      current,
      choose5: true,
      instruction: String(opts.instruction || ""),
      securityQuestion: "",
      securityAnswer: "",
      retypeSecurityAnswer: "",
      firstCDKey: "",
      parentalPassword: password(""),
    },
  };
}
async function create(opts) {
  const result = await mp.playerauctionsAccountRequest(
    "POST",
    "/offers/Account",
    body(opts),
  );
  const direct =
    typeof result === "object"
      ? result && (result.offerId || result.id)
      : result;
  const url = typeof result === "object" ? result?.url : result;
  const id = /^\d+$/.test(String(direct || ""))
    ? direct
    : mp.playerauctionsOfferIdFromUrl(url);
  if (!/^\d+$/.test(String(id || "")))
    throw new Error(
      "PlayerAuctions did not return an offer ID; reconcile the seller's offers before retrying",
    );
  return String(id);
}
const read = (id) =>
  mp.playerauctionsAccountRequest(
    "GET",
    "/offers/Account/" + encodeURIComponent(id),
  );
const orderAccount = (id) =>
  mp.playerauctionsAccountRequest(
    "GET",
    "/Order/QueryAccount/" + encodeURIComponent(id),
  );
module.exports = { body, contact, password, create, read, orderAccount };
