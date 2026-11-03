# CHZZK account generator

Local app on 127.0.0.1:4109; separate extension and encrypted vault. One
private browser window and one signup at a time. Interrupted identities stay
reserved. No automatic batch until a single account has been verified end to end.

Owner rule 2026-11-03: every future signup, including a logged manual signup,
uses the existing residential proxy. Open only about:blank before configuration.
Verify the prepared sticky exit on the local service AND in the assigned private
browser before navigating to Naver. A mismatched, expired, missing or overridden
proxy stops signup; no direct fallback and no number purchase. Proxy settings
apply only to this profile's incognito session. No unrelated private window may
coexist, including on Resume. Supply proxy authentication only to the exact
configured challenger for the assigned signup/probe tabs. Clear helper session,
recovery data and private proxy configuration when the window closes.

Read proxy credentials from the existing protected ~/epic-claim/.env; never put
them in git or normal UI state. Resume keeps the same unexpired sticky exit.
The connection-only proxy test creates no signup or SMS order.

5sim product is `naver`. Fetch current stock, sort available countries by their
cheapest number, and buy with operator `any` plus a provider-enforced `maxPrice`.
Default cap $0.05 per attempt, 10 attempts per signup, $0.25 gross purchase budget.
Prices/currency are the provider's API values. No background purchases on startup.
An ambiguous purchase response blocks another buy until reconciled against order
history. Persist the intent before buying and the received order immediately.

Owner instruction 2026-11-03: when SMS fails, keep the same signup and browser
session, go back to the number screen, change the number, and switch country on
repeated failures. Cheapest first, not highest advertised delivery rate. Canada,
Portugal and Netherlands have previously worked, but do not override price order.
After ten seconds without SMS, close Naver's code popup and use the cheapest
different country on every replacement (owner's revised instruction).
Prefer untried countries before revisiting a failed country, still cheapest first.
Never rotate after an SMS code has arrived: resolve that signup first. Cancel unused
orders and record confirmed terminal state before buying a replacement. An order
that cannot be cancelled holds the signup until it expires or cancellation works.
Keep the SMS popup open until cancellation is confirmed so a code arriving in
the cancellation response can still be entered. Match country name and dialing
prefix together: Canada and the USA share +1. A request that never opens Naver's
SMS popup pauses after 15 seconds without buying or pretending SMS was sent.

5sim token lives in the generator's settings.json outside git, mode 0600. Browser
receives only the active identity, assigned number and that order's SMS code.
Local list responses omit credentials, cookies and SMS. Extension accepts commands
only from the exact local app page and reads cookies only from its assigned private
store. It must see the assigned Naver login ID in Naver's authenticated profile
before saving, then verify CHZZK userStatus. Unknown state pauses rather than
declaring success. Automatic signup accepts the required Naver agreements (owner instruction
2026-11-03); optional choices remain unchecked. Logged manual demonstration
mode stays passive. Visual challenges can be completed in the browser.

Save credentials and cookies locally before finishing the 5sim order. Durable
upload queue feeds the existing farm over SSH/stdin; no public import endpoint.
Cloud import verifies login via the configured farm egress, inserts only new
accounts, and rejects existing users rather than changing sold/paused state.
Server-side cookie renewal remains the existing CHZZK farm's responsibility.
Never claim a signup or farming success without live evidence.
