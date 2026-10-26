// One Naver login's cookie jar, shared by every client of that login
// (docs/CHZZK-COOKIE-KEEPALIVE.md). The worker, the login check and the code
// collector each build their own client; they all read and renew the same
// store, so a cookie Naver renews on one call is sent on the next call of
// every other client too.
//
// `generation` is the account row's cookieAt (ms) the jar was loaded from.
// The farm uses it to tell "renewed in place" from "re-imported".
// Nothing here logs; onChange gets cookie NAMES only.

const { mergeSetCookies } = require("./cookies");

function createJarStore({ cookies = [], generation = 0, onChange = null, now = Date.now } = {}) {
  let jar = Array.isArray(cookies) ? cookies.map((c) => ({ ...c })) : [];
  let gen = Number(generation) || 0;

  return {
    cookies: () => jar.map((c) => ({ ...c })),
    get generation() { return gen; },
    // Merge one answer's Set-Cookie lines. Returns { changed, ignored }.
    // `sentGen` = the generation the request went out with; an answer to a
    // request sent before replace() is about the old jar and is dropped.
    absorb(lines, host, sentGen) {
      if (!lines || (Array.isArray(lines) && !lines.length)) return { changed: [], ignored: [] };
      if (sentGen != null && Number(sentGen) !== gen) return { changed: [], ignored: [], stale: true };
      const r = mergeSetCookies(jar, lines, host, now());
      if (r.changed.length) jar = r.jar;
      if ((r.changed.length || r.ignored.length) && typeof onChange === "function") {
        try { onChange({ changed: r.changed, ignored: r.ignored }); } catch (_e) { /* never break a request */ }
      }
      return { changed: r.changed, ignored: r.ignored };
    },
    // A fresh import (or a reload from the row): new contents, new generation.
    replace(next, nextGeneration) {
      jar = Array.isArray(next) ? next.map((c) => ({ ...c })) : [];
      gen = Number(nextGeneration) || 0;
    },
  };
}

module.exports = { createJarStore };
