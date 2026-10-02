// Makes every route see the same path express.static is about to serve.
//
// Guarded pages are declared as explicit routes ahead of the static mount, e.g.
//   app.get("/bulk-orders.html", requireSuperadmin, enforce2fa, sendFile)
// Express matches routes against the RAW path (still percent-encoded), while
// express.static (send) decodes and normalises it before opening a file. So
// "/bulk%2Dorders.html", "//bulk-orders.html", "/./bulk-orders.html" and
// "/x/../bulk-orders.html" all missed the route, fell through to the static
// mount and got public/bulk-orders.html — signed out. Review 2026-09-30: every
// guarded page in public/ was affected, admin, renter and reseller alike.
//
// For a GET/HEAD whose path the static mount would read differently from how
// the router reads it, this looks up the file static would open and rewrites
// req.url to that file's real name. Every route after it — each page's own
// guards included — then matches exactly as for the plain URL, so there is no
// second list of protected pages to keep in step with server.js. Upper-case
// URLs need nothing here (Express routing ignores case). Taking the name from
// disk also covers case-insensitive filesystems (macOS dev machines), where
// "/BULK%2DORDERS.HTML" or a Kelvin-sign "K" still opens the lower-case file.
const fs = require("fs");
const path = require("path");

// send refuses a path that still climbs out of the root after normalising.
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

// The public/-relative path express.static would open for this URL path, or
// null when it would refuse the request anyway (bad escape, NUL, escapes root).
// Mirrors send's own steps: decodeURIComponent, then normalize("./" + path).
function staticRelativePath(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes("\0")) return null;
  p = path.normalize("." + path.sep + p);
  return UP_PATH_REGEXP.test(p) ? null : p;
}

function toUrlPath(relPath, encode) {
  const segments = relPath.split(path.sep).filter((s) => s && s !== ".");
  const url =
    "/" + segments.map(encode ? encodeURIComponent : String).join("/");
  // Keep a directory's trailing slash: static serves its index only with it.
  return relPath.endsWith(path.sep) && url !== "/" ? url + "/" : url;
}

function canonicalPath(publicDir) {
  const root = path.resolve(publicDir);
  let realRoot = root;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    // Missing public/ — nothing is served from it, so nothing to canonicalise.
  }

  return function canonicalPathMiddleware(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const rel = staticRelativePath(req.path);
    // Already the literal path of what static would open: routes saw it too.
    if (rel === null || toUrlPath(rel, false) === req.path) return next();

    fs.realpath.native(path.join(root, rel), (err, real) => {
      // Not on disk: static serves nothing for it, so leave routing as-is
      // (API paths with encoded params keep their raw form this way).
      if (err) return next();
      let onDisk = path.relative(realRoot, real);
      // A symlink that leaves public/ has no public URL of its own; keep the
      // name as requested.
      if (UP_PATH_REGEXP.test(onDisk) || path.isAbsolute(onDisk)) onDisk = rel;
      else if (rel.endsWith(path.sep)) onDisk += path.sep;
      const q = req.url.indexOf("?");
      req.url = toUrlPath(onDisk, true) + (q === -1 ? "" : req.url.slice(q));
      return next();
    });
  };
}

module.exports = { canonicalPath };
