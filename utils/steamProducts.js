// Exact products eligible for Steam account offers. Game ownership/playtime
// comes from the worker and remains attached after its confirmed logout.
const { GAMES, nameOf } = require('./steamBoostGames');
const supported = new Set(GAMES.map(g => g.appId));
const select = (id, value) => ({ id, type: 'Select', values: [value] });
const numeric = (id, value) => ({ id, type: 'Numeric', value });
function normalize(raw = {}) {
  const kind = raw.kind || 'region';
  if (!['region', 'game', 'boosted'].includes(kind)) throw Error('Unknown Steam product');
  if (kind === 'region') return { kind, appId: 0, minHours: 0 };
  const appId = Number(raw.appId), minHours = kind === 'boosted' ? Number(raw.minHours) : 0;
  if (!supported.has(appId)) throw Error('Choose a supported Steam game');
  if (kind === 'boosted' && ![500, 1000].includes(minHours)) throw Error('Boosted products require 500 or 1000 verified hours');
  return { kind, appId, minHours };
}
function blockers(acc, p) {
  const game = (acc.games || []).find(g => g.appId === p.appId);
  if (!game || !game.verifiedAt) return ['game ownership has not been verified by Steam'];
  if (Number(game.playtimeMinutes) < (p.kind === 'boosted' ? p.minHours * 60 : 2)) return ['not enough Steam-recorded playtime for this product'];
  return [];
}
function section(p, fallback) {
  if (p.kind === 'region') return fallback;
  if (p.appId === 1172470) return {
    key: 'steam-apex', name: 'Apex Legends Steam accounts', gameId: '33', tradeEnvironmentId: '0', seoAlias: 'apex-legends-accounts',
    offerAttributes: [select('apex-legends-exotic-shards', 'exotic-019'), select('apex-legends-heirloom', 'heirloom-03'), select('apex-legends-legendary-skins', 'skins-019'), select('apex-legends-level', 'level-119'), select('apex-legends-rank', 'rank-unranked'), numeric('apex-legends-heirloom-count', 0), numeric('apex-legends-level-numeric', 1), numeric('apex-legends-legendary-skins-count', 0), numeric('apex-legends-exotic-shards-numeric', 0)],
  };
  if (p.appId === 730) return {
    key: 'steam-cs2', name: 'CS2 Steam accounts', gameId: '20', tradeEnvironmentId: '0', seoAlias: 'cs2-accounts',
    offerAttributes: [select('counter-strike-2-coin', 'other-coin'), select('counter-strike-2-esea', 'esea-other'), select('counter-strike-2-faceit', 'faceit-other'), select('counter-strike-2-medals', '0-9-medals'), select('counter-strike-2-prime-status', 'non-prime'), numeric('cs2-faceit-level-numeric', 0), numeric('cs2-medals-numeric', 0), numeric('cs2-premier-rating-numeric', 0)],
  };
  return fallback;
}
function text(p, region, regionName, emailText) {
  const name = nameOf(p.appId);
  const label = p.kind === 'boosted' ? `${p.minHours} Idle (Boosted) Hours` : 'Free Game Added';
  const details = [
    `• ${name} free version added and verified.`,
    ...(p.appId === 730 ? ['• Non-Prime account.', '• No competitive rank, Premier access, skins or medals included.'] :
      p.appId === 1172470 ? [
        '• No Apex level, rank, skins, heirlooms or other progression included.',
        '• An EA account is required to play and is not included. Link an eligible EA account of your own when launching the game.',
      ] : ['• No paid edition, rank, skins, achievements or in-game progression included.',
        '• A separate third-party game account is not included; use your own if the game requires one.']),
    p.kind === 'boosted' ? `• At least ${p.minHours} hours recorded by Steam for ${name}. These are idle/boosted hours, not active gameplay.` :
      '• A small amount of Steam-recorded idle playtime may be present.',
    `• Signup country: ${regionName} (${region}). The finalized Steam Store country is not guaranteed.`,
    "• Steam's $5 USD account limitation has not been removed.",
  ];
  return {
    title: `${name} | Steam Account | ${label} | ${regionName} | Email Codes | Instant Delivery`.slice(0, 160),
    description: [
      `Receive one newly created Steam account with ${name} already added to its library. Your login details are delivered automatically on the Eldorado order page after payment.`,
      ['ACCOUNT DETAILS', ...details].join('\n'),
      emailText,
    ].join('\n\n').slice(0, 2000),
  };
}
module.exports = { normalize, blockers, section, text };
