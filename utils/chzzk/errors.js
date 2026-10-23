// One error type for everything the CHZZK farm can fail on, so callers branch
// on a code instead of matching message text (docs/CHZZK-FARM.md §2).
//
// Codes:
//   "AUTH"    logged out (HTTP 401, or 403 with body.code 30001, or a user call
//             saying loggedIn:false)
//   "EGRESS"  proxy missing/unusable/refused, network unreachable
//   "TIMEOUT" no full answer in time
//   "HTTP"    non-JSON body where JSON was expected, or a 5xx / unexpected status
//   "API"     CHZZK answered JSON with body.code !== 200 (message = body.message)

class ChzzkError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message);
    this.name = "ChzzkError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

const isAuthError = (e) => Boolean(e) && e.code === "AUTH";

// A timeout counts as an egress problem: with a tunnel in the path it almost
// always is one, and neither may ever be read as "this login is dead".
const isEgressError = (e) =>
  Boolean(e) && (e.code === "EGRESS" || e.code === "TIMEOUT");

module.exports = { ChzzkError, isAuthError, isEgressError };
