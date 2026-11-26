# ADR-003: One message bank, planner and outgoing history

**Status:** Implemented in source; coordinated paused activation required.
**Date:** 2026-11-26

The owner requested one place to edit messages and decide which of the three personal companions speaks. The existing coordinator already owns SQLite, rate limits, permits and bounded paired exchanges. Ordinary greetings, replies and participation were still selected independently by extensions, while the controller merely projected each helper's recent history.

Keep the existing Mac host behind the protected site. Its `HostStore` connection is the only writer. A director on that connection adds immutable bank revisions, exact message plans, migration acknowledgements, consumed opportunity tombstones and canonical outgoing history. Existing contributions remain the only shared send-budget ledger. Existing permit IDs remain attempt identities; late completion replay enriches the same history row.

The bank includes greeting/topic variants, recognized reply categories, metadata wording and paired scenes, plus the three central mode/source preferences. Whole-bank revision checks prevent lost edits. Request IDs bind immutable mutations. Changing the bank cancels unused work, including pending paired runs; a submitting provider request stays immutable. Scene identity derives from the original durable scene mapping or exact scene content. Disabling, renaming, changing and restoring text cannot erase consumed scene identities.

Helpers retain Twitch OAuth, current EventSub messages and inspected channel state. Extensions retain browser playback evidence and final Stop/session checks. Helpers report bounded observations; incoming bodies stay in memory. The director persists exact outgoing text before it can authorize submission. A plan binds its account, channel, broadcast, reply target, control generation/session/settings revision and exact UTF-8 digest separately from the unchanged duplicate fingerprint.

AI generation is an account-bound provider request to the existing local helper adapter. It happens outside SQLite transactions and does not move its private key. The host selects the target/source and durably consumes generation once. A result must still match the original target digest, control binding, bank/profile revision, broadcast and freshness. No match, cancellation or stale results cannot restart an already handled generation. There is no automatic local fallback.

Each helper and browser first freezes and durably imports its own available outgoing records and independent participation/handled tombstones. Sequential pages are digest-bound and replayable. The host will not issue automatic work until both sources finish for every registered client. Missing historical text remains explicitly unavailable. Existing SQLite, journals and completion outboxes are never reset.

The protected site remains an exact route/typed-body gateway. It gains Messages, bank editing, unused-plan cancellation and bounded outgoing history. It receives no private bindings, authority epoch, migration transfer IDs or incoming chat bodies in the director projection. No new force-send, retry, clear-history, arbitrary proxy, account allocation, browser permission or Twitch scope is introduced.

The installed entry point enables director authority explicitly. Coordination-only unit fixtures can retain the older permit contract without pretending to be a running director. A rollback must preserve all newer SQLite/history/outcomes and keep automatic work held; restoring an older autonomous extension is not a valid recovery step.

Protocol, exact schemas, migration and route rules: [CENTRAL-DIRECTOR-1126.md](CENTRAL-DIRECTOR-1126.md).
