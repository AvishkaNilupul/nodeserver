// Gameflip's own answer that it has no such listing.
//
// Everything that hands an account back to stock, or books a listing as taken
// down, turns on this one question — and a wrong "yes" leaves a login on sale
// behind an account that is stock again. So the answer is accepted only in
// Gameflip's own voice: HTTP 404 carrying its JSON error envelope,
//
//   {"status":"FAILURE","data":null,"error":{"message":"Not Found","code":404,"http_status":404}}
//
// read live 2026-10-11 for a deleted listing and for an id that never existed
// (a SOLD listing stays readable for good). Not accepted:
//   - an error that merely SAYS "not found" (a refused key says it too);
//   - a 404 from anything in between — a proxy's or a CDN's page has no such
//     body, and says nothing about the listing.
// `err` is what utils/marketplaces throws (apiError): `status` is the HTTP
// status and the message ends with the response body.
function gameflipGone(err) {
  if (!err || err.status !== 404) return false;
  return /"http_status"\s*:\s*404/.test(String(err.message || ""));
}

module.exports = { gameflipGone };
