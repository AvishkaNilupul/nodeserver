const { randomBytes } = require("node:crypto");

const icon = (paths) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const SIDEBAR = `<aside class="nav" aria-label="RedeemHub navigation">
  <a class="brand" href="/superadmin.html"><span class="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 8.5 12 15 22 8.5 12 2"></polygon><path d="M2 8.5v7L12 22l10-6.5v-7"></path></svg></span><b>RedeemHub<span>Admin console</span></b></a>
  <nav class="links" aria-label="Server pages">
    <a href="/admin.html">${icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>')}Inbox</a>
    <a href="/orders">${icon('<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18M7 14h6"></path>')}Orders</a>
    <a href="/inventory">${icon('<path d="M20 7H4M16 3H8M6 11h12l-1 10H7z"></path>')}Inventory</a>
    <a href="/twitch-follows.html">${icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>')}Twitch follows</a>
  </nav>
  <div class="me"><span class="av" aria-hidden="true">--</span><div class="who"><b>Admin</b><span id="meRole">Super Admin</span></div><a class="account-link" href="/settings.html" aria-label="Account settings" title="Account settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"></path></svg></a><button class="logout" id="controller-logout" type="button" aria-label="Log out" title="Log out"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"></path></svg></button></div>
</aside>`;

// The ordinary admin menu creates its own style elements. Authorize only those
// styles with this document's nonce instead of permitting arbitrary inline CSS.
function navigationPolicy(upstreamCsp, nonce) {
  const source = upstreamCsp || "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const directives = new Map();
  for (const entry of String(source).split(";")) {
    const [name, ...values] = entry.trim().split(/\s+/);
    if (!name) continue;
    if (directives.has(name)) throw new Error("Duplicate controller security policy directive.");
    directives.set(name, values.join(" "));
  }
  directives.set("style-src", `'self' 'nonce-${nonce}'`);
  // Generated offline documents have no upstream scripts or connection policy.
  if (!directives.has("script-src")) directives.set("script-src", "'self'");
  if (!directives.has("connect-src")) directives.set("connect-src", "'self'");
  return [...directives].map(([name, value]) => `${name} ${value}`).join("; ");
}

function renderControllerPage(source, upstreamCsp) {
  if (typeof source !== "string" || !/<head\b[^>]*>/i.test(source) || !/<\/head\s*>/i.test(source)
      || !/<body\b[^>]*>/i.test(source) || !/<\/body\s*>/i.test(source)
      || source.includes('class="controller-content"')) throw new Error("Unexpected controller document.");
  const nonce = randomBytes(24).toString("base64url");
  const assets = `<link rel="stylesheet" href="/twitch-controller-shell.css?v=20261125-nav"><link rel="stylesheet" href="/admin-nav.css"><script src="/twitch-controller-shell.js?v=20261125-nav"></script><script defer src="/admin-nav.js?v=20261125-controller-nav" nonce="${nonce}"></script>`;
  let html = source.replace(/<\/head\s*>/i, `${assets}</head>`);
  html = html.replace(/<body\b([^>]*)>/i, (_match, attributes) => {
    if (/\bclass\s*=/i.test(attributes)) attributes = attributes.replace(/\bclass\s*=\s*(["'])(.*?)\1/i, (_class, quote, value) => `class=${quote}${value} controller-site${quote}`);
    else attributes += ' class="controller-site"';
    return `<body${attributes}>${SIDEBAR}<div class="controller-content">`;
  }).replace(/<\/body\s*>/i, "</div></body>");
  return { html, csp: navigationPolicy(upstreamCsp, nonce) };
}

module.exports = { renderControllerPage };
