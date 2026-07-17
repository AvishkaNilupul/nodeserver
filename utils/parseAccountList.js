// Parses the colon-delimited account lists suppliers hand over, which arrive as
// one account per line rather than the JSON shapes /account-pool/import
// originally accepted:
//   login:password:token   (token = Twitch OAuth token -> clientSecret)
//   login:password:email
//   login:password
//
// Slot 3 is disambiguated by "@" so an email pasted there isn't stored as a
// bogus token that then fails its auto-check against Twitch. A leading "*"/"-"
// bullet is tolerated so a list copied out of a chat or markdown note imports
// as-is. Lines that don't split into 2-3 non-empty fields are reported back
// rather than guessed at — a password containing ":" would otherwise be
// silently mangled into the wrong columns.
function parseAccountList(text) {
  const accounts = [];
  const badLines = [];
  for (const rawLine of String(text == null ? "" : text).split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[*-]\s+/, "");
    if (!line) continue;
    const parts = line.split(":").map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) {
      badLines.push(line.slice(0, 80));
      continue;
    }
    const [username, password, third] = parts;
    const acc = { username, password };
    if (third) {
      if (third.includes("@")) acc.email = third;
      else acc.clientSecret = third;
    }
    accounts.push(acc);
  }
  return { accounts, badLines };
}

module.exports = { parseAccountList };
