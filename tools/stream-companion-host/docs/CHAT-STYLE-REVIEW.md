# Account styles and evidence review

This tool prepares a bank for a later session. It does not contact the controller,
edit its database, change the active run, or publish chat. The existing protected
Messages page and revision-checked bank Save remain the only activation path.

The four finite styles are compact/direct, curious, warm/supportive, and dry.
They differ in wording and reply habits, with no invented personal lives or claims
about video/audio. Automation and capability questions retain truthful answers.
Styles are ordinary bank groups assigned to existing account IDs; there is no new
profile schema, provider permission, model credential, or helper-side rewrite.

The first stock-bank conversion reduces unsolicited chatter: only the primary
profile retains an automatic arrival greeting, and generic topic questionnaires
are disabled. Direct and supported human replies receive separate account wording.
Existing disabled groups and selective account assignments stay disabled/selective.
Custom groups and approved exchange scenes retain their content and assignments.
Scripted exchanges are flagged for editorial review; their content identity,
consumed-scene ledger, timers and routing are not regenerated to hide repetition.

## Prepare the next bank

Save a private snapshot of the current bank and canonical outgoing history using
the existing authenticated controller reads. Keep real history outside the public
repository. A bank snapshot can be `{ "revision": 8, "bank": ... }`; a history
snapshot can be `{ "capturedAt": "...Z", "history": [...] }`.

```sh
node scripts/review-chat-style.mjs \
  --bank /absolute/private/bank-snapshot.json \
  --history /absolute/private/history-snapshot.json \
  --output /absolute/private/new-style-proposal
```

The output directory must not exist. Review the private `review.json`,
`candidate-bank.json`, and `proposal.json`. Outputs are owner-only. The proposal
records the input fingerprint and reference revision; a changed live bank requires
a new review rather than an overwrite. Preserve all newer history and journals.

The review reports observed message shapes, confirmed-text coverage, repeated
wording and account assignments. Missing historical text stays unknown. A repeated
phrase across an old session is not automatically a duplicate-guard failure; an
unanswered message is not evidence that a viewer disliked it. Incoming target
bodies are not part of canonical outgoing history, so retrospective grounding and
audience reaction cannot be inferred from these records alone.

## Use feedback after each run

Run the review against each completed session's preserved evidence. Review its
recommendations, then supply deliberate negative feedback as:

```json
{ "avoidTextKeys": ["0123456789abcdef"] }
```

Pass it with `--feedback /absolute/private/reviewed-feedback.json`. The example
key is illustrative; use the 16-hex keys emitted by the review. Keys are the same
normalized text fingerprints used by the existing duplicate policy. Feedback
removes matching authored style lines; removing one live/offline metadata line
removes the whole pair to preserve ordering. Existing edited style lines are
retained except for explicit matching exclusions. Custom and exchange content is
reported for review rather than silently rewritten. An exhausted reply category
stays quiet. There is no autonomous phrase generation, model training, rate
increase, or unreviewed live self-edit.

## Activation and verification

Finish the current measured run and report its original results first. Check the
proposal's exact input revision and `bankFingerprint` against a fresh live bank,
then use the existing bank Save with one unique request ID. Reconcile an uncertain
response through current revision/request identity; never blindly retry. Saving
must not reset greeted broadcasts, consumed targets/scenes, delivery outcomes,
account modes, pacing, restrictions, or USA routing. Inspect the resulting bank
and next actual messages before judging whether a style improvement worked.

The two-hour report recorder and its scheduled follow-up are independent of this
offline tool. Their evidence must not be edited or relabelled with the proposed
styles.
