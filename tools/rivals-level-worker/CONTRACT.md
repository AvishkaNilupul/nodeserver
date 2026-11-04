# Rivals leveling worker

Scope: one already held, unlisted Rivals preparation on this Mac, with its real
game UID checked before play. Complete Practice vs AI matches and measure actual
account XP. The target is level 15; match XP, hero proficiency and Chrono Tokens
are separate values. No marketplace publishing, account switching, protocol
claims, process memory access, or changes to the existing claim ledger phases.

The claim worker's active session is authoritative. Another live owner prevents
leveling. An explicit handoff and the existing queue lease are required. A live
production read must still confirm the Steam account is held, unsold and unlisted
before any match is queued. Recheck between matches. Existing listed stock is
never used. The leveling ledger stores only identifiers and observed evidence;
credentials stay in the existing encrypted claim queue.

Native input targets the exact observed game PID and window title. Inputs are
bounded, release keys/buttons on every error, and stop when focus changes, the
game closes, the local STOP file appears, or a configured runtime limit expires.
Unknown dialogs, disconnects and XP that cannot be verified stop the run. No
automatic clicking of legal terms, authentication, purchases or permissions.

Screenshots come from the actual full display (per-window Metal captures can be
stale), cropped to freshly discovered game bounds. OCR locations come from that
same screenshot. Menu coordinates are derived from observed text; gameplay
uses visible image features. Store original evidence privately, outside git.

The first live benchmark is one match. Automated replay is commissioned only
after a completed match produces actual account XP and the game client responds
to bounded controls. A unit test or dry run is not evidence of game progress.
Persist baseline, result XP, elapsed time, level and original screenshots; never
report a synthetic fixture, button click or Steam playtime as account leveling.
