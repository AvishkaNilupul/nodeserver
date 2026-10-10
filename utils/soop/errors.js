// One error type for everything the SOOP farm can fail on, so callers branch on
// a code instead of matching message text.
//
// Codes:
//   "AUTH"    the session is not logged in
//   "EGRESS"  proxy missing or down, network unreachable, country unknown
//   "TIMEOUT" the request ran out of time
//   "HTTP"    the reply was not JSON (or the request could not be sent as built)
//   "API"     SOOP answered result !== 1 for another reason

class SoopError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = "SoopError";
    this.code = code;
    this.cause = cause;
  }
}

// SOOP words a logged-out reply several ways, in English or Korean.
const LOGIN_RE = /log ?in|sign ?in|로그인/i;

const isAuthError = (e) => Boolean(e) && e.code === "AUTH";

// A timeout is treated as an egress problem: with a tunnel in the path it almost
// always is one, and neither may ever be read as "this account is dead".
const isEgressError = (e) =>
  Boolean(e) && (e.code === "EGRESS" || e.code === "TIMEOUT");

// One plain-English sentence per failure kind, for anything shown in the panel.
const PLAIN = {
  EGRESS: "Could not reach SOOP — the proxy or the network is down",
  TIMEOUT: "SOOP did not answer in time — try again in a moment",
  HTTP: "SOOP sent a reply that could not be read — try again in a moment",
  API: "SOOP refused the request — try again in a moment",
  AUTH: "SOOP says the account is logged out — re-import its cookie",
};
const plainMessage = (e) => (e && PLAIN[e.code]) || (e && e.message) || "Unknown error";

module.exports = {
  PLAIN,
  plainMessage, SoopError, LOGIN_RE, isAuthError, isEgressError };
