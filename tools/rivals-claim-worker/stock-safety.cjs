function assertTwitchSafe(s) {
  const no = message => { throw Error(message); };
  if(!s||s.version!==1)no('Stock evidence is incomplete');
  if(s.twitchTwins!==1)no('Twitch login is duplicated or ambiguous');
  if(!s.twitch||!s.twitch.hasPassword||s.twitch.lastScanStatus!=='ok'||s.twitch.soldAt||s.twitch.resellerId||s.twitch.copiedCount>0)no('Twitch account is not clean unsold stock');
  if(s.twitchCommittedDrops||s.twitchConnectedDrops||s.twitchListingRefs||s.twitchLeaseRefs||s.twitchResellerRefs||s.twitchUnclaimedRefs)no('Twitch account is sold, linked, reserved or leased');
  if(s.pool.some(p=>p.manualSold||(p.soldGames||[]).length||(p.usageHistory||[]).some(x=>['sold','rented','spent'].includes(x.event))))no('Twitch pool has buyer or lease history');
  if(s.liveLogin!==s.twitch.login||!s.liveTwitchId||s.twitch.twitchId&&s.liveTwitchId!==s.twitch.twitchId)no('Live Twitch identity does not match');
  if(!Array.isArray(s.liveRewards)||!s.liveRewards.length||s.liveRewards.some(r=>r.connected))no('No unlinked Marvel Rivals rewards were verified live');
  return true;
}
function assertPreparationSafe(s) {
  assertTwitchSafe(s);
  if(!s.steam||s.steam.soldAt||!['stock','boosting','problem'].includes(s.steam.stage))throw Error('Steam account is not available for preparation');
  if(s.steamListingRefs||s.steamSaleRefs||s.steamG2gRefs||s.otherPreparationRefs)throw Error('Steam account has marketplace, buyer or preparation references');
  return true;
}
function assertStockSafe(s) {
  assertPreparationSafe(s);
  if(s.steam.stage!=='problem'||!s.steam.holdNote)throw Error('Steam account is not exclusively held for preparation');
  if(s.steamBoostActive||(!s.steamLogoutAt&&!s.steamNeverBoosted))throw Error('Steam booster has not acknowledged logout');
  return true;
}
module.exports={assertStockSafe,assertTwitchSafe,assertPreparationSafe};
