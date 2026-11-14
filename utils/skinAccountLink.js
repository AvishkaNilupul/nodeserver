// Read-only identity proof against Epic's authenticated account service.
// The current response supplies twitch_name + numeric twitch_id authIds;
// a display name alone never proves which Twitch identity receives rewards.
function proof(auths, epicId, twitchId) {
  if (!Array.isArray(auths)) return false;
  const links = auths.filter((x) => x.type === "twitch");
  if (links.length !== 1 || links[0].accountId !== epicId) return false;
  const a = links[0],
    ids = (a.authIds || [])
      .filter((x) => x.type === "twitch_id")
      .map((x) => String(x.id));
  if (a.externalAuthIdType === "twitch_id") ids.push(String(a.externalAuthId));
  if (a.externalAuthSecondaryId) ids.push(String(a.externalAuthSecondaryId));
  return ids.length > 0 && ids.every((v) => v === String(twitchId));
}
async function verify(skin, account) {
  const token = await require("./epicAccountToken").accountAccessToken(account);
  const r = await require("axios").get(
    "https://account-public-service-prod.ol.epicgames.com/account/api/public/account/" +
      encodeURIComponent(account.accountId) +
      "/externalAuths",
    {
      headers: { Authorization: "bearer " + token },
      timeout: 20000,
      validateStatus: () => true,
    },
  );
  if (r.status !== 200) throw new Error("Epic link verification unavailable");
  if (!proof(r.data, account.accountId, skin.twitchId)) {
    const e = new Error(
      "Epic’s connected Twitch identity is different or disconnected; verify the account link",
    );
    e.user = true;
    e.status = 409;
    throw e;
  }
  return {
    checkedAt: new Date(),
    epicAccountId: account.accountId,
    twitchId: skin.twitchId,
  };
}
module.exports = { verify, proof };
