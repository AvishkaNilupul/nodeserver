# Nodeserver project context

## Imported Claude project memory

The curated Claude memory for this project is available at:

`/Users/avishkanilupul/.claude/projects/-Users-avishkanilupul-projects-nodeserver/memory/`

Start with `memory/MEMORY.md`. It is the index of the durable notes and links to the detailed records. Read the relevant linked note before making changes in that area. The raw `*.jsonl` session transcripts are historical evidence only; use them when the curated notes do not answer a question.

This memory import is intentionally read-only. Do not modify or delete Claude's memory files, and do not copy secrets, credentials, session transcripts, or production-only configuration into this repository.

## High-value project rules

- **Plati (Digiseller) and GGSel are BLOCKED by the owner since 2026-09-28** (both seller accounts are blocked by the platforms). Do not list, feed, top up or spend any account there — automatically or by hand — and do not turn `autoFarm.platiEnabled` / `autoFarm.ggselEnabled` back on until the owner says the accounts are fixed. Details and the re-enable checklist: memory note `project_plati_ggsel_blocked.md`.
- This checkout is the local development/working copy. Production is a separate remote checkout. Check the imported production-server note before deploying.
- Fingerprint production files against the intended local/Git ref before overwriting them. Production commonly contains a deliberate mix of branch tips, so `git rev-parse` alone is not a parity check.
- Use the established targeted-copy deployment convention: back up overwritten files into a timestamped `_deploy_backup_<timestamp>/` directory, deploy only the intended files, re-fingerprint, then restart PM2 when runtime code changed.
- Preserve unrelated work in the current dirty worktree. Do not reset, discard, or overwrite user changes without explicit permission.
- MongoDB production runs on an Atlas shared tier: do not add `allowDiskUse`; keep aggregations under the memory limit by rewriting/projection/batching instead.
- Scope Twitch work to Twitch unless the user explicitly asks for another platform. Do not implement automated Twitch chat posting from bot/aging accounts.
- Treat account ownership, sold/connected state, reservations, duplicate-login filtering, renter/reseller leases, and listing contents as integrity-sensitive. Read the relevant memory note and existing tests before changing these paths.
- Manual marketplace listings must not be repriced by auto-farm logic. Auto-delivery/listing changes need platform-specific notes because the APIs and lifecycle rules differ.
- After committing or deploying code changes, refresh the Graphify index/studio and verify it was built from the current commit when the Graphify workflow applies.
- Push deployed code to the configured GitHub origin as the off-server code backup when the task includes a deployment or release.
- For large changes, keep work in small, independently verifiable chunks and write the contract/assumptions down before fan-out.

## Useful verification habits

- Check `.graphify/` freshness before broad “about the site” questions; use it as the fast code index, then inspect source for details.
- For production admin routes, use the documented throwaway Express harness with a stub session rather than inventing an auth bypass.
- For bot-host reads, use the batched host-read utilities and account for Pi latency/outages; do not fan out serial SSH reads.
- Treat scanner lag, stale watch threads, capacity caps, and token-integrity false positives as distinct failure modes; use the corresponding memory diagnostic note before changing code.

## Source of truth

The imported Claude corpus contains the detailed project history, decisions, deployment observations, platform constraints, and known traps. This file is only the operating index for Codex; the external corpus remains the source of detail.
