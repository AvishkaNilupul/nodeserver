const {prepareProxy, browserLocation} = require('../steam-signup/regions.cjs');

// Riot's shards are distinct from residence countries. These are signup targets,
// not proof of the eventual VALORANT shard. Never sell against this prediction.
const targets = {
  US: 'NA', CA: 'NA', DE: 'EU', GB: 'EU', FR: 'EU', PL: 'EU',
  TR: 'EU', UA: 'EU', RO: 'EU', ES: 'EU', AE: 'EU', EG: 'EU',
  JP: 'AP', SG: 'AP', AU: 'AP', IN: 'AP', PH: 'AP', TH: 'AP',
  MX: 'LATAM', AR: 'LATAM', CL: 'LATAM', CO: 'LATAM', BR: 'BR',
};
const names = new Intl.DisplayNames(['en'], {type: 'region'});
const countries = Object.entries(targets).map(([code, expectedShard]) => ({
  code, name: names.of(code), expectedShard,
})).sort((a,b) => a.name.localeCompare(b.name));
function cleanCountry(value) {
  if (!Object.hasOwn(targets, value)) throw Error('Choose a supported Valorant signup country');
  return value;
}
module.exports = {countries, cleanCountry, expectedShard: country => targets[cleanCountry(country)], prepareProxy, browserLocation};
