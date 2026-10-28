// Refresh tokens rotate: serialize across processes and persist before any
// library/checkout work. Never attach a rotated token to a long-lived document.
const crypto = require("crypto");
const EpicAccount = require("../models/EpicAccount");
const epic = require("./epicClient");
const { encrypt, decrypt } = require("./secretBox");

function createTokenStore({ collection, refresh, encrypt, decrypt, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const cache = new Map();
  return async function accountAccessToken(account, opts = {}) {
    const id = account._id;
    const owner = crypto.randomUUID();
    const deadline = now() + 25000;
    let row;
    while (!row) {
      row = await collection.findOneAndUpdate({ _id: id, $or: [
        { tokenRefreshLease: { $exists: false } },
        { "tokenRefreshLease.expiresAt": { $lte: new Date(now()) } },
      ] }, { $set: { tokenRefreshLease: { owner, expiresAt: new Date(now() + 60000) } } },
      { returnDocument: "after" });
      if (!row) {
        if (now() >= deadline) throw new Error("Account is busy. Try again shortly.");
        await sleep(100);
      }
    }
    const match = { _id: id, "tokenRefreshLease.owner": owner, refreshToken: row.refreshToken };
    try {
      const hit = cache.get(String(id));
      if (!opts.forceRefresh && hit && hit.refreshToken === row.refreshToken && hit.expiresAt > now()) return hit.accessToken;
      const tok = await refresh(decrypt(row.refreshToken));
      if (!tok.access_token || !tok.refresh_token || (tok.account_id && tok.account_id !== row.accountId)) {
        throw new Error("Epic returned an incomplete or mismatched token bundle");
      }
      const stored = encrypt(tok.refresh_token);
      const result = await collection.updateOne(match, { $set: {
        refreshToken: stored,
        refreshExpiresAt: tok.refresh_expires_at ? new Date(tok.refresh_expires_at) : null,
        ...(tok.displayName ? { displayName: tok.displayName } : {}),
        status: "ok", lastError: "", updatedAt: new Date(now()),
      } });
      if (result.matchedCount !== 1) throw new Error("Account login changed. Try again.");
      const ttl = Math.min(300000, Math.max(0, (Number(tok.expires_in) || 3600) * 1000 - 60000));
      cache.set(String(id), { refreshToken: stored, accessToken: tok.access_token, expiresAt: now() + ttl });
      return tok.access_token;
    } catch (err) {
      // Epic includes the rejected token in its error text; don't expose it.
      if (/invalid_grant|invalid_refresh_token|TOKEN_NOT_FOUND/i.test(String(err.epicCode || "") + " " + err.message)) {
        const safe = new Error("Epic login expired or was revoked. Sign in again to reconnect this account.");
        safe.epicCode = "invalid_grant";
        await collection.updateOne(match, { $set: { status: "needs_login", lastError: safe.message } });
        throw safe;
      }
      throw err;
    } finally {
      await collection.updateOne({ _id: id, "tokenRefreshLease.owner": owner }, { $unset: { tokenRefreshLease: "" } });
    }
  };
}

const accountAccessToken = createTokenStore({ collection: EpicAccount.collection, refresh: token => epic.refresh(token), encrypt, decrypt });
module.exports = { accountAccessToken, createTokenStore };
