# ADR-002: Bounded, explicitly labelled companion exchanges

**Status:** Accepted and implemented
**Date:** 2026-11-25 (Asia/Tokyo)

## Context and decision

The owner requested occasional exchanges between the two personal companions, with varied wording and pauses. Keep the existing ban on unbounded companion-triggered reply chains. Instead the host schedules a single scene with exactly two possible lines, and every public line identifies itself as `[companion bot]`.

Both clients must independently report current playback and participation metadata for the same live broadcast. The host persists one schedule per channel, alternates speakers, draws from unused local scenes, and grants the existing single-use send permits. Human conversation keeps priority. A confirmed first line can unlock only its predetermined second line; uncertainty, rejection, stale identity or leaving the stream ends the scene.

```mermaid
stateDiagram-v2
    [*] --> Waiting: Both eligible and enabled
    Waiting --> FirstDue: Persisted 60–120 minute interval
    FirstDue --> ReplyWaiting: First line confirmed
    ReplyWaiting --> SecondDue: 3–6 minutes and normal limits
    SecondDue --> Done: Second line attempted
    FirstDue --> Cancelled: Partner stale / stop / changed broadcast
    ReplyWaiting --> Cancelled: Partner stale / stop / deadline
    FirstDue --> Done: Rejected or uncertain
    Done --> Waiting: New interval, unused scene
    Cancelled --> Waiting: New interval, unused scene
```

The host stores scene identifiers, timestamps and outcomes rather than incoming chat text. Content is local and bounded; it does not require model generation or new credentials. Existing Twitch inspections and shared budgets apply at the provider boundary. No live fast-forward or demonstration send is introduced.

## Tradeoffs

Curated scenes give predictable boundaries and exact-text validation, with a finite supply. When all scenes have been used in a channel, the feature stops until new scenes are added. Slow intervals keep this secondary to the stream's conversation. Requiring both profiles to stay fresh means a browser observation interruption can cancel an exchange, which is preferable to continuing alone or replaying old lines after recovery.

Revisit scene authoring if the owner wants a larger collection. Revisit hosting only if the browser workers move to an always-on machine; this feature does not keep a sleeping Mac online.
