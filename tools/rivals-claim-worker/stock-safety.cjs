function assertStockSafe(s) {
  const no = message => { throw Error(message); };
  if(!s||s.version!==1)no('Stock evidence is incomplete');
  if(!s.steam||s.steam.stage!=='problem'||!s.steam.holdNote||s.steam.soldAt)no('Steam account is not exclusively held for preparation');
  if(s.steamListingRefs||s.steamSaleRefs||s.steamG2gRefs)no('Steam account has marketplace or buyer references');
  if(s.steamBoostActive||!s.steamLogoutAt)no('Steam booster has not acknowledged logout');
  if(s.twitchTwins!==1)no('Twitch login is duplicated or ambiguous');
  if(!s.twitch||!s.twitch.hasPassword||s.twitch.lastScanStatus!=='ok'||s.twitch.soldAt||s.twitch.resellerId||s.twitch.copiedCount>0)no('Twitch account is not clean unsold stock');
  if(s.twitchCommittedDrops||s.twitchConnectedDrops||s.twitchListingRefs||s.twitchLeaseRefs||s.twitchResellerRefs||s.twitchUnclaimedRefs)no('Twitch account is sold, linked, reserved or leased');
  if(s.pool.some(p=>p.manualSold||(p.soldGames||[]).length||(p.usageHistory||[]).some(x=>['sold','rented','spent'].includes(x.event))))no('Twitch pool has buyer or lease history');
  if(s.liveLogin!==s.twitch.login||!s.liveTwitchId||s.twitch.twitchId&&s.liveTwitchId!==s.twitch.twitchId)no('Live Twitch identity does not match');
  if(!Array.isArray(s.liveRewards)||!s.liveRewards.length||s.liveRewards.some(r=>r.connected))no('No unlinked Marvel Rivals rewards were verified live');
  return true;
}
module.exports={assertStockSafe};
